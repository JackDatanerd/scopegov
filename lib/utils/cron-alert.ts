// lib/utils/cron-alert.ts
//
// FEATURE (cron audit, section 17 — feature gap, closing pass): every one
// of the 10 crons under app/api/cron/* only ever `console.error`d an
// uncaught failure and returned a 500 — visible solely to someone already
// reading Vercel logs at the right moment. Several of these are
// consequential enough that a silent failure has real cost:
// payment-overdue drives grace-period downgrades and Paystack
// cancellations, project-purge/workspace-purge do irreversible hard
// deletes, trial-warning is the only thing that ever tells a client their
// trial is ending. lib/billing/ops-alert.ts and guardian-health's own
// local alertOps() both already solve this exact problem for their own
// domains (same ops_alert_state table/cooldown, same "only mark the
// cooldown after a successful send" discipline — a Resend outage
// shouldn't also silently eat the next retry window). This generalizes
// that same mechanism for the crons that had neither, rather than adding
// a third near-duplicate implementation or awkwardly repurposing
// alertBillingOps's billing-specific "[Billing]" subject line for a
// project-purge failure.
//
// Two call sites, one core sender: alertCronFailure fires from inside a
// run that started and threw; alertCronMissedHeartbeat fires from the
// watchdog (app/api/cron/cron-heartbeat-watchdog) for a run that appears
// not to have happened at all — see migration 058.

import { sendEmail } from '@/lib/email/send'
import { systemFrom } from '@/lib/email/from'

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// One cooldown per (cronName, key suffix) pair, not per individual error —
// a cron that's broken for a week shouldn't re-page on every single run,
// but should page again once cooldownMs has elapsed if it's still broken.
// Default 1h matches lib/billing/ops-alert.ts.
async function sendOpsAlert(
  service: any, key: string, subject: string, message: string, cooldownMs: number,
): Promise<boolean> {
  console.error(`[CRON ALERT] ${subject}: ${message}`)
  const to = process.env.OPS_ALERT_EMAIL
  if (!to) return false
  try {
    const { data } = await service.from('ops_alert_state').select('last_sent_at').eq('key', key).maybeSingle()
    if (data && Date.now() - new Date(data.last_sent_at).getTime() < cooldownMs) return false

    // FIX (Notifications & email fix round): this "mark only after a
    // successful send" discipline was written around a send that reports
    // failure by throwing — the Resend SDK doesn't, so a rejected page still
    // consumed the cooldown. Check the actual result.
    const res = await sendEmail({
      from:    systemFrom('ScopeGov Ops'),
      to,
      subject: `[Cron] ${subject}`,
      html:    `<div style="font-family:monospace;white-space:pre-wrap;">${escapeHtml(message)}</div>`,
    })
    if (!res.ok) {
      console.error('Cron ops alert email failed:', res.error)
      return false
    }
    await service.from('ops_alert_state').upsert({ key, last_sent_at: new Date().toISOString() })
    return true
  } catch (e) {
    console.error('Cron ops alert itself failed to send:', e)
    return false
  }
}

export async function alertCronFailure(
  service: any, cronName: string, err: unknown, cooldownMs = 60 * 60_000,
): Promise<boolean> {
  const message = err instanceof Error ? (err.stack || err.message) : String(err)
  return sendOpsAlert(service, `cron:${cronName}:failure`, `${cronName} failed`, message, cooldownMs)
}

export async function alertCronMissedHeartbeat(
  service: any, cronName: string, message: string, cooldownMs = 60 * 60_000,
): Promise<boolean> {
  return sendOpsAlert(service, `cron:${cronName}:missed`, `${cronName} hasn't run recently`, message, cooldownMs)
}
