// lib/billing/ops-alert.ts
//
// Billing failures that need a human (a payment we could not attribute to a
// workspace, a previous subscription we failed to disable, a dispute or
// refund). Before this, every one of these was a bare console.error inside a
// webhook that then returned 200 — i.e. visible only to someone already
// reading Vercel logs at the right minute. Same delivery channel and
// cooldown table as the guardian-health cron (OPS_ALERT_EMAIL +
// ops_alert_state); degrades to console-only when OPS_ALERT_EMAIL is unset.

import { sendEmail } from '@/lib/email/send'
import { systemFrom } from '@/lib/email/from'

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function alertBillingOps(
  service: any, key: string, subject: string, lines: string[], cooldownMs = 60 * 60_000,
): Promise<boolean> {
  console.error(`[BILLING ALERT] ${subject}\n${lines.join('\n')}`)
  const to = process.env.OPS_ALERT_EMAIL
  if (!to) return false
  try {
    const { data } = await service.from('ops_alert_state').select('last_sent_at').eq('key', key).maybeSingle()
    if (data && Date.now() - new Date(data.last_sent_at).getTime() < cooldownMs) return false
    // FIX (Notifications & email fix round): see lib/utils/cron-alert.ts — the
    // Resend SDK reports failure by resolving `{ error }`, never by throwing,
    // so this used to arm the cooldown after a page that was never sent.
    const res = await sendEmail({
      from: systemFrom('ScopeGov Ops'),
      to,
      subject: `[Billing] ${subject}`,
      html: `<div style="font-family:monospace;white-space:pre-wrap;">${lines.map(escapeHtml).join('\n')}</div>`,
    })
    if (!res.ok) {
      console.error('Billing ops alert email failed:', res.error)
      return false
    }
    await service.from('ops_alert_state').upsert({ key, last_sent_at: new Date().toISOString() })
    return true
  } catch (e) {
    console.error('Billing ops alert failed to send:', e)
    return false
  }
}
