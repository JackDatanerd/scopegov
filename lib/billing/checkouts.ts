// lib/billing/checkouts.ts
//
// Server-side record of "workspace W started a checkout for plan P as
// customer E" — see migration 056 (billing_checkouts) for why the browser's
// popup metadata can't be trusted to say which workspace a payment is for.

export const CHECKOUT_TTL_MS = 24 * 60 * 60_000

export interface PendingCheckout {
  id: string
  workspace_id: string
  user_id: string | null
  email: string
  plan_key: string
  plan_interval: string
  plan_code: string
  created_at: string
}

export async function createPendingCheckout(service: any, c: {
  workspaceId: string; userId: string; email: string; planKey: string; interval: string; planCode: string
}): Promise<void> {
  const { error } = await service.from('billing_checkouts').insert({
    workspace_id: c.workspaceId, user_id: c.userId, email: c.email.trim().toLowerCase(),
    plan_key: c.planKey, plan_interval: c.interval, plan_code: c.planCode,
  })
  if (error) throw new Error(`could not record checkout: ${error.message}`)
}

/**
 * The workspace a (customer email, plan code) payment belongs to, decided
 * ONLY from rows this server created. `hintWorkspaceId` (the browser's
 * metadata) can break a tie between candidates; it can never add one.
 */
export async function findPendingCheckout(
  service: any, email: string, planCode: string, hintWorkspaceId?: string | null, now: number = Date.now(),
): Promise<PendingCheckout | null> {
  if (!email || !planCode) return null
  const since = new Date(now - CHECKOUT_TTL_MS).toISOString()
  const { data, error } = await service.from('billing_checkouts')
    .select('id, workspace_id, user_id, email, plan_key, plan_interval, plan_code, created_at')
    .eq('email', email.trim().toLowerCase()).eq('plan_code', planCode)
    .is('consumed_at', null).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(10)
  if (error) throw new Error(`checkout lookup failed: ${error.message}`)
  const rows: PendingCheckout[] = data || []
  if (!rows.length) return null
  return (hintWorkspaceId && rows.find(r => r.workspace_id === hintWorkspaceId)) || rows[0]
}

export async function consumeCheckout(service: any, id: string): Promise<void> {
  const { error } = await service.from('billing_checkouts')
    .update({ consumed_at: new Date().toISOString() }).eq('id', id).is('consumed_at', null)
  if (error) console.error('[BILLING] could not mark checkout consumed:', id, error.message)
}
