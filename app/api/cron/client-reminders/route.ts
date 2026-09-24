export const runtime = 'nodejs'
// One email + two audit rows per due document across every opted-in workspace — same unbounded shape
// payment-overdue carries this override for.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { insertAuditRow } from '@/lib/utils/audit'
import { CronRun, fetchAll } from '@/lib/utils/cron-run'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { sendClientDocumentReminderEmail, sendInvoiceReminderEmail } from '@/lib/email/templates'
import { renewInvoiceTokenIfExpired } from '@/lib/documents/renew-invoice-token'
import { isReminderDue, summarizeReminders, type ReminderEvent } from '@/lib/utils/client-reminder-schedule'

// FEATURE (cron/portal audit round 2). Every stall cron only ever told the AGENCY; chasing the client was a manual
// "Remind" click per document. Workspaces that opt in (Settings → Workspace → Client reminders, default OFF) get:
//   • an unsigned SOW,
//   • a change order still awaiting the client's response or countersignature,
//   • an invoice that is COMING DUE (cron/portal audit round 3: ONE friendly heads-up, `DUE_SOON_DAYS` before the due
//     date — until now the only automatic invoice email was the overdue nag, sent after the money was already late),
//   • an overdue invoice (skipped while the client has an OPEN dispute on it — they've raised a question, they
//     don't need a payment nag; the agency needs to answer it),
// nudged after `client_reminder_after_days` days and then every that-many days, at most `client_reminder_max`
// automatic reminders per document. Sends use the same wording, cc rules and reply-to as the manual buttons, and are
// logged as `reminder.sent` (metadata.automatic = true) so the manual 24h cooldown and the agency's audit trail see them.
//
// Daily. Must be registered in the scheduler (Cloudflare worker) — nothing in this repo schedules it.
//
// FIX (cron audit, section 17 re-pass): this is already registered in
// EXPECTATIONS in cron-heartbeat-watchdog/route.ts (same open question as
// notification-cleanup — see that file's comment for the full reasoning).
// Kept registered rather than pulled back out: silently dropping heartbeat
// coverage risks masking a real failure later, which is worse than a
// loud, cooldown-limited false alarm now if the worker turns out not to
// call this yet. MANUAL VERIFICATION NEEDED: confirm the
// scopegov-cron-worker schedule actually includes `client-reminders` — if
// it doesn't, add it there rather than removing the EXPECTATIONS entry.

type Kind = 'sow' | 'co' | 'invoice'

/** How many days before its due date an unpaid invoice gets its single "coming due" heads-up. */
const DUE_SOON_DAYS = 3

/** The client said they paid and no payment has been recorded since. */
function hasOpenPaymentClaim(inv: { payment_claimed_at?: string | null; payment_claim_cleared_at?: string | null }): boolean {
  if (!inv.payment_claimed_at) return false
  return !inv.payment_claim_cleared_at || new Date(inv.payment_claim_cleared_at) < new Date(inv.payment_claimed_at)
}
const ENTITY: Record<Kind, string> = { sow: 'sow', co: 'change_order', invoice: 'invoice' }

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const run = new CronRun(service, 'client-reminders')
  const now = new Date()
  const nowIso = now.toISOString()
  const portalBase = process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL
  const sent = { sow: 0, co: 0, invoice: 0, invoiceDueSoon: 0 }

  await run.step('send automatic client reminders', async () => {
    const workspaces = await fetchAll<any>('client-reminders workspaces select', (from, to) =>
      (service as any).from('workspaces')
        .select('id, agency_name, brand_colour, client_reminder_after_days, client_reminder_max')
        .eq('auto_client_reminders', true).is('deleted_at', null)
        .order('id').range(from, to))

    for (const ws of workspaces) {
      try {
        const afterDays = ws.client_reminder_after_days || 3
        const max       = ws.client_reminder_max || 3
        const replyTo   = await resolveReplyTo(service, ws.id, null)

        // ── gather candidates ────────────────────────────────────────────────────────────
        const clientEmbed = 'clients(name, email, cc_emails)'
        const todayStr = nowIso.slice(0, 10)
        const soonStr  = new Date(now.getTime() + DUE_SOON_DAYS * 86400000).toISOString().slice(0, 10)
        const [sows, cos, invoices, dueSoonInvoices] = await Promise.all([
          fetchAll<any>('reminder SOWs', (from, to) => (service as any).from('sow_documents')
            .select(`id, token, sent_at, expires_at, project_id, projects!inner(id, name, status, client_id, deleted_at, ${clientEmbed})`)
            .eq('workspace_id', ws.id).eq('status', 'awaiting_signature')
            .not('token', 'is', null).not('sent_at', 'is', null)
            .in('projects.status', ['Awaiting Signature', 'Stalled']).is('projects.deleted_at', null)
            .order('id').range(from, to)),
          fetchAll<any>('reminder COs', (from, to) => (service as any).from('change_orders')
            .select(`id, title, status, token, sent_at, expires_at, project_id, projects!inner(id, name, client_id, deleted_at, ${clientEmbed})`)
            .eq('workspace_id', ws.id).in('status', ['awaiting_response', 'stalled', 'awaiting_countersignature'])
            .not('token', 'is', null).not('sent_at', 'is', null).is('projects.deleted_at', null)
            .order('id').range(from, to)),
          fetchAll<any>('reminder invoices', (from, to) => (service as any).from('invoices')
            .select(`id, title, status, token, expires_at, due_date, amount, amount_paid, currency, invoice_number, payment_instructions,
              disputed_at, dispute_resolved_at, payment_claimed_at, payment_claim_cleared_at, project_id, projects!inner(id, name, client_id, deleted_at, ${clientEmbed})`)
            .eq('workspace_id', ws.id).eq('status', 'overdue').not('token', 'is', null).is('projects.deleted_at', null)
            .order('id').range(from, to)),
          // Unpaid and due within DUE_SOON_DAYS (today included). Not overdue yet — this is the heads-up.
          fetchAll<any>('reminder due-soon invoices', (from, to) => (service as any).from('invoices')
            .select(`id, title, status, token, expires_at, due_date, amount, amount_paid, currency, invoice_number, payment_instructions,
              disputed_at, dispute_resolved_at, payment_claimed_at, payment_claim_cleared_at, project_id, projects!inner(id, name, client_id, deleted_at, ${clientEmbed})`)
            .eq('workspace_id', ws.id).in('status', ['sent', 'partially_paid']).not('token', 'is', null).is('projects.deleted_at', null)
            .gte('due_date', todayStr).lte('due_date', soonStr)
            .order('id').range(from, to)),
        ])

        const candidates: Array<{ kind: Kind; doc: any; dueSoon?: boolean }> = [
          ...sows.filter((d: any) => !d.expires_at || new Date(d.expires_at) > now).map((doc: any) => ({ kind: 'sow' as Kind, doc })),
          ...cos.filter((d: any) => !d.expires_at || new Date(d.expires_at) > now).map((doc: any) => ({ kind: 'co' as Kind, doc })),
          // an open dispute means the client asked a question — answering it is the agency's move, not a nag
          // FEATURE (cron/portal audit round 3): likewise an open "I've paid" claim — the client says the money is
          // on its way; nagging them for it is exactly what the claim exists to stop. Recording a payment (which
          // clears the claim) or the agency disputing it resumes reminders.
          ...invoices.filter((d: any) => !(d.disputed_at && !d.dispute_resolved_at) && !hasOpenPaymentClaim(d)).map((doc: any) => ({ kind: 'invoice' as Kind, doc })),
          ...dueSoonInvoices.filter((d: any) => !(d.disputed_at && !d.dispute_resolved_at) && !hasOpenPaymentClaim(d) && Number(d.amount) - Number(d.amount_paid) > 0.005)
            .map((doc: any) => ({ kind: 'invoice' as Kind, doc, dueSoon: true })),
        ]
        if (!candidates.length) continue

        // ── reminder history, in one query per entity type ──────────────────────────────────
        const events = new Map<string, ReminderEvent[]>()
        const dueSoonNet = new Map<string, number>() // invoice id -> (due-soon claims) - (due-soon failures)
        for (const kind of ['sow', 'co', 'invoice'] as Kind[]) {
          const ids = candidates.filter(c => c.kind === kind).map(c => c.doc.id)
          for (let i = 0; i < ids.length; i += 100) {
            const rows = await fetchAll<any>('reminder history', (from, to) => (service as any).from('audit_log')
              .select('id, entity_id, event_type, created_at, metadata')
              .eq('workspace_id', ws.id).eq('entity_type', ENTITY[kind]).in('entity_id', ids.slice(i, i + 100))
              .in('event_type', ['reminder.sent', 'reminder.failed']).order('id').range(from, to))
            for (const r of rows) {
              // A "coming due" heads-up is tracked on its own: it must neither count toward the overdue nag's
              // `max` nor move its cadence anchor, but a failed one has to cancel its claim (same rule as below).
              if (r.metadata?.due_soon === true) {
                dueSoonNet.set(r.entity_id, (dueSoonNet.get(r.entity_id) || 0) + (r.event_type === 'reminder.sent' ? 1 : -1))
                continue
              }
              const list = events.get(r.entity_id) || []
              list.push({ type: r.event_type === 'reminder.sent' ? 'sent' : 'failed', at: r.created_at, automatic: r.metadata?.automatic === true })
              events.set(r.entity_id, list)
            }
          }
        }

        // ── send ────────────────────────────────────────────────────────────────────────────
        for (const { kind, doc, dueSoon } of candidates) {
          try {
            const sentAt = kind === 'invoice' ? (doc.due_date ? `${doc.due_date}T00:00:00Z` : null) : doc.sent_at
            const history = summarizeReminders(events.get(doc.id) || [])
            if (dueSoon) {
              if ((dueSoonNet.get(doc.id) || 0) > 0) continue // already given its one heads-up
            } else if (!isReminderDue({ now, sentAt, history, afterDays, max })) continue

            const project = doc.projects
            const client  = project?.clients
            if (!client?.email) continue // nowhere to send; the manual button reports this loudly, a cron just skips

            // Claim first (like the manual routes) so a crash after sending can't cause a duplicate tomorrow.
            const claimed = await insertAuditRow(service, {
              workspace_id: ws.id, actor_id: null, actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
              event_type: 'reminder.sent', entity_type: ENTITY[kind], entity_id: doc.id,
              entity_name: kind === 'co' ? doc.title : project?.name,
              metadata: { type: kind, automatic: true, client_email: client.email, ...(dueSoon ? { due_soon: true } : { reminder_number: history.autoCount + 1 }) },
            })
            if (!claimed) throw new Error('could not record the reminder — not sending')

            const cc = await withPrimaryContactCc(service, project?.client_id, client.email, client.cc_emails)
            const log = { workspaceId: ws.id, kind: `${kind}.auto_reminder`, entityType: ENTITY[kind], entityId: doc.id, projectId: project?.id }
            let result: { ok: boolean; error?: string }

            if (kind === 'invoice') {
              let token = doc.token as string
              const renewal = await renewInvoiceTokenIfExpired(service, doc.id, ws.id, doc.status, doc.expires_at)
              if (renewal.renewed && renewal.token) token = renewal.token
              result = await sendInvoiceReminderEmail({
                replyTo, log, to: client.email, cc, clientName: client.name || 'there', agencyName: ws.agency_name,
                projectName: project?.name || doc.title, invoiceNumber: doc.invoice_number, title: doc.title,
                balanceDue: Number(doc.amount) - Number(doc.amount_paid), currency: doc.currency || 'USD', dueDate: doc.due_date,
                portalUrl: `${portalBase}/portal/invoice/${token}`, brandColour: ws.brand_colour, isOverdue: !dueSoon, dueSoon: !!dueSoon,
                paymentInstructions: doc.payment_instructions,
              })
            } else {
              result = await sendClientDocumentReminderEmail({
                replyTo, log, kind, to: client.email, cc, clientName: client.name || 'there', agencyName: ws.agency_name,
                projectName: project?.name || '', documentTitle: kind === 'co' ? doc.title : null,
                portalUrl: `${portalBase}/portal/${kind}/${doc.token}`, brandColour: ws.brand_colour, expiresAt: doc.expires_at,
                needsCountersignature: kind === 'co' && doc.status === 'awaiting_countersignature',
              })
            }

            if (!result.ok) {
              await insertAuditRow(service, {
                workspace_id: ws.id, actor_id: null, actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
                event_type: 'reminder.failed', entity_type: ENTITY[kind], entity_id: doc.id,
                entity_name: kind === 'co' ? doc.title : project?.name,
                metadata: { type: kind, automatic: true, error: result.error, ...(dueSoon ? { due_soon: true } : {}) },
              })
              run.rowError(`${kind} ${doc.id}`, new Error(`reminder email rejected: ${result.error}`))
              continue
            }
            if (dueSoon) sent.invoiceDueSoon++; else sent[kind]++
          } catch (e) { run.rowError(`${kind} ${doc.id}`, e) }
        }
      } catch (e) { run.rowError(`workspace ${ws.id}`, e) }
    }
    Object.assign(run.result, { sowRemindersSent: sent.sow, coRemindersSent: sent.co, invoiceRemindersSent: sent.invoice, invoiceDueSoonRemindersSent: sent.invoiceDueSoon })
  })

  const { body, status } = await run.finish()
  return NextResponse.json(body, { status })
}

// Vercel Cron / the scheduler worker may invoke with GET; POST is the canonical method.
export const GET = POST
