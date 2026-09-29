// lib/billing/audit-retry.ts
//
// FIX (Billing independent pass 7 — B1): billing/cancel and billing/resume awaited logAudit() and threw its
// boolean away. logAudit resolves `false` on a failed insert (it never throws). billing/history is built ONLY
// from audit_log, and since the claim-first cancel rewrite the webhook's not_renew handler deliberately exits
// early when the cancel route already set the flag — so the route's row is the ONLY record of the
// cancellation. A failed insert therefore meant the cancel/resume vanished from Payment history with nobody told.
//
// Mirrors the webhook's audit(): one immediate retry, then page ops with everything needed to add the row by
// hand. Never throws and never fails the user's action (the cancellation/resume itself already happened).

import { logAudit } from '@/lib/utils/audit'
import { alertBillingOps } from '@/lib/billing/ops-alert'

type AuditParams = Parameters<typeof logAudit>[1]

export async function logBillingAuditWithRetry(service: any, params: AuditParams): Promise<boolean> {
  try {
    if (await logAudit(service, params)) return true
    await new Promise(r => setTimeout(r, 250))
    if (await logAudit(service, params)) return true
  } catch (e) {
    console.error('[BILLING] audit retry threw:', e)
  }
  await alertBillingOps(
    service,
    `billing:audit-write:${params.eventType}:${params.workspaceId}:${String(params.metadata?.action ?? 'x')}`,
    'Billing audit row could not be written',
    [
      `workspace: ${params.workspaceId}`,
      `event type: ${params.eventType}`,
      `actor: ${params.actorEmail}`,
      `metadata: ${JSON.stringify(params.metadata ?? {}).slice(0, 800)}`,
      'The change itself was applied; add the entry to audit_log by hand so Payment history is complete.',
    ],
  )
  return false
}
