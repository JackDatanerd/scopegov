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

export interface BillingRecipient { name: string; email: string }

const DEAD_ADDRESS = /@deleted\.scopegov\.app$/i

export async function getBillingRecipients(
  service: any,
  workspaceId: string,
  extras: Array<{ name?: string | null; email?: string | null } | null | undefined> = [],
): Promise<BillingRecipient[]> {
  const out = new Map<string, BillingRecipient>()
  const add = (name: string | null | undefined, email: string | null | undefined) => {
    if (!email || DEAD_ADDRESS.test(email)) return
    const k = email.toLowerCase()
    if (!out.has(k)) out.set(k, { name: name || email, email })
  }
  try {
    const holders = await getMembersWithPermission(service, workspaceId, 'MANAGE_BILLING', 25)
    for (const h of holders) add(h.name, h.email)
  } catch (e) {
    console.error('getBillingRecipients: MANAGE_BILLING lookup failed (using extras only):', e)
  }
  for (const x of extras) add(x?.name, x?.email)
  return Array.from(out.values())
}
