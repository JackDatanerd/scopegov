// lib/billing/recipients.ts
//
// Who is told about billing events (payment failed, subscription cancelled /
// resumed / ended, card expiring).
//
// The cron previously kept a private copy of this that looked up members
// holding MANAGE_WORKSPACE_SETTINGS — but every billing action in the app
// (upgrade, cancel, resume, history) is gated on MANAGE_BILLING, and the
// comment there even claimed the opposite. A custom role with billing but
// not settings authority never got the email that concerns exactly what they
// are responsible for; one with settings but not billing got emails about
// something they can't act on. Recipients are now the MANAGE_BILLING holders,
// plus any explicit extras (workspace creator, the payer's email).

import { getMembersWithPermission } from '@/lib/utils/permissions-query'

// `id` is the recipient's user id when known (MANAGE_BILLING holders always; extras only when the caller supplies it), so
// callers that must honour a per-person notification preference (lib/billing/trial-audience.ts) can look it up.
export interface BillingRecipient { name: string; email: string; id?: string }

const DEAD_ADDRESS = /@deleted\.scopegov\.app$/i

export async function getBillingRecipients(
  service: any,
  workspaceId: string,
  extras: Array<{ id?: string | null; name?: string | null; email?: string | null } | null | undefined> = [],
): Promise<BillingRecipient[]> {
  const out = new Map<string, BillingRecipient>()
  const add = (name: string | null | undefined, email: string | null | undefined, id?: string | null) => {
    if (!email || DEAD_ADDRESS.test(email)) return
    const k = email.toLowerCase()
    if (!out.has(k)) out.set(k, { name: name || email, email, ...(id ? { id } : {}) })
  }
  try {
    const holders = await getMembersWithPermission(service, workspaceId, 'MANAGE_BILLING', 25)
    for (const h of holders) add(h.name, h.email, h.id)
  } catch (e) {
    console.error('getBillingRecipients: MANAGE_BILLING lookup failed (using extras only):', e)
  }
  for (const x of extras) add(x?.name, x?.email, x?.id)
  return Array.from(out.values())
}
