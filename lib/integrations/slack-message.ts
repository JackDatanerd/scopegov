// lib/integrations/slack-message.ts
//
// Turns a delivery envelope into a Slack message (Block Kit). Pure: no network, no secrets.
//
// SAFETY — everything dynamic is escaped with Slack's own three entities (& < >). Slack only treats <!channel>, <!here>,
// <@U…>, <#C…> and <url|label> as special when they appear between angle brackets, so escaping "<" means text a CLIENT
// wrote (a decline reason, a dispute note) can never ping the whole channel, mention a person, or forge a link. The
// message carries no `link_names`, so a bare "@channel" in someone's text stays plain text.
//
// Limits respected (Slack rejects the whole message otherwise): section text <= 3000, field text <= 2000, <= 10 fields,
// header-ish text kept short, <= 50 blocks.

import { formatMoney } from '@/lib/utils/money'

export interface SlackMessage { text: string; blocks: any[] }

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const clean = (s: unknown, n: number) => esc(clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n))

const PRESENT: Record<string, { emoji: string; headline: string }> = {
  'sow.signed': { emoji: ':white_check_mark:', headline: 'SOW signed' },
  'sow.declined': { emoji: ':x:', headline: 'SOW declined' },
  'sow.changes_requested': { emoji: ':memo:', headline: 'SOW changes requested' },
  'sow.expired': { emoji: ':hourglass:', headline: 'SOW signing link expired' },
  'sow.stalled': { emoji: ':warning:', headline: 'SOW stalled' },
  'change_order.accepted': { emoji: ':white_check_mark:', headline: 'Change order accepted' },
  'change_order.declined': { emoji: ':x:', headline: 'Change order declined' },
  'change_order.countered': { emoji: ':left_right_arrow:', headline: 'Change order countered' },
  'change_order.expired': { emoji: ':hourglass:', headline: 'Change order expired' },
  'change_order.stalled': { emoji: ':warning:', headline: 'Change order stalled' },
  'guardian.flag_raised': { emoji: ':rotating_light:', headline: 'Scope flag raised' },
  'guardian.flag_stalled': { emoji: ':warning:', headline: 'Scope flag needs attention' },
  'invoice.sent': { emoji: ':incoming_envelope:', headline: 'Invoice sent' },
  'invoice.paid': { emoji: ':moneybag:', headline: 'Payment received' },
  'invoice.payment_claimed': { emoji: ':raised_hand:', headline: 'Client says they have paid' },
  'invoice.overdue': { emoji: ':alarm_clock:', headline: 'Invoice overdue' },
  'invoice.disputed': { emoji: ':speech_balloon:', headline: 'Invoice disputed' },
  'milestone.overdue': { emoji: ':alarm_clock:', headline: 'Payment milestone overdue' },
  'retainer.ending': { emoji: ':calendar:', headline: 'Retainer ending' },
  'integration.test': { emoji: ':wave:', headline: 'ScopeGov is connected' },
}

/** Which project tab shows the thing this event is about. */
function tabFor(type: string): string {
  if (type.startsWith('sow.')) return 'sow'
  if (type.startsWith('change_order.')) return 'co'
  if (type.startsWith('guardian.')) return 'guardian'
  return 'billing'
}

const money = (amount: unknown, currency: unknown) => (amount === null || amount === undefined ? null : formatMoney(Number(amount), String(currency ?? '') || null))
const date = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 10) : null)

export function buildSlackMessage(envelope: any, opts: { appUrl?: string | null } = {}): SlackMessage {
  const type = String(envelope?.type || '')
  const p = PRESENT[type] || { emoji: ':bell:', headline: type || 'ScopeGov event' }
  const data = envelope?.data || {}
  const doc = data.document || {}
  const cur = doc.currency ?? envelope?.project?.currency
  const projectName = envelope?.project?.name

  const fields: Array<[string, string | null | undefined]> = [
    ['Project', projectName ? clean(projectName, 120) : null],
    ['Client', envelope?.client?.name ? clean(envelope.client.name, 120) : null],
  ]
  if (doc.type === 'sow') fields.push(['SOW', [doc.number, doc.version ? `v${doc.version}` : null].filter(Boolean).map(x => clean(x, 40)).join(' · ') || null])
  if (doc.type === 'change_order') {
    fields.push(['Change order', [doc.number, doc.title].filter(Boolean).map(x => clean(x, 80)).join(' · ') || null], ['Amount', money(doc.total, cur)])
  }
  if (doc.type === 'invoice') {
    fields.push(['Invoice', [doc.number, doc.title].filter(Boolean).map(x => clean(x, 80)).join(' · ') || null], ['Amount', money(doc.amount, cur)])
    if (Number(doc.balance_due) > 0) fields.push(['Balance due', money(doc.balance_due, cur)])
    fields.push(['Due', date(doc.due_date)])
  }
  if (doc.type === 'payment_milestone') fields.push(['Milestone', doc.title ? clean(doc.title, 100) : null], ['Amount', money(doc.amount, cur)], ['Due', date(doc.due_date)])
  if (doc.type === 'guardian_flag') fields.push(['Severity', doc.severity ? clean(doc.severity, 20) : null], ['SOW reference', doc.sow_reference ? clean(doc.sow_reference, 80) : null])
  if (data.signed_by) fields.push(['Signed by', clean(data.signed_by, 80)])
  if (data.accepted_by) fields.push(['Accepted by', clean(data.accepted_by, 80)])
  if (data.counter_amount !== undefined && data.counter_amount !== null) fields.push(['Counter offer', money(data.counter_amount, cur)])
  if (data.payment?.amount !== undefined) fields.push(['Payment', [money(data.payment.amount, cur), data.payment.method ? clean(data.payment.method, 30) : null].filter(Boolean).join(' · ')])
  if (data.days_unsigned) fields.push(['Days unsigned', String(Number(data.days_unsigned) || '')])
  if (data.days_unanswered) fields.push(['Days waiting', String(Number(data.days_unanswered) || '')])
  if (data.days_open) fields.push(['Days open', String(Number(data.days_open) || '')])
  if (data.retainer?.term_months) fields.push(['Term', `${Number(data.retainer.term_months)} months`])
  if (data.under_dispute === true) fields.push(['Status', 'Under dispute'])

  const blocks: any[] = []
  const summary = data.summary || data.message ? clean(data.summary ?? data.message, 600) : ''
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`${p.emoji} *${esc(p.headline)}*${summary ? `\n${summary}` : ''}`, 2900) } })

  const shown = fields.filter((f): f is [string, string] => !!f[1]).slice(0, 10)
  if (shown.length) blocks.push({ type: 'section', fields: shown.map(([k, v]) => ({ type: 'mrkdwn', text: clip(`*${esc(k)}*\n${v}`, 1900) })) })

  // Quoted client words go in their own block so they read as quotes, not as ScopeGov's own voice.
  const quote = data.reason || data.feedback || data.dispute_note || data.counter_note || data.claim_note
  if (quote) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(`> ${clean(quote, 500)}`, 2900) } })

  const base = (opts.appUrl || '').replace(/\/+$/, '')
  if (/^https?:\/\//.test(base) && envelope?.project_id && /^[0-9a-f-]{36}$/i.test(String(envelope.project_id))) {
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in ScopeGov' }, url: `${base}/projects/${envelope.project_id}?tab=${tabFor(type)}` }] })
  }

  const text = `${p.headline}${projectName ? ` — ${clip(String(projectName).replace(/[<>&]/g, ''), 100)}` : ''}`
  return { text, blocks }
}
