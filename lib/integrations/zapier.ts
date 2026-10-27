// lib/integrations/zapier.ts
//
// Server side of the Zapier integration: REST-hook subscriptions created by Zapier (through the app in
// integrations/zapier) using a workspace API key.

import { integrationAllowed } from './plans'

export const ZAPIER_HOOK_HOST = 'hooks.zapier.com'
export const MAX_ZAPIER_HOOKS_PER_WORKSPACE = 100

/**
 * Zapier hands us the URL it wants events POSTed to. Unlike a customer webhook this host is KNOWN, so it is pinned: a
 * stolen or misused API key cannot be used to aim deliveries at an arbitrary server through the Zapier route.
 */
export function validateZapierTarget(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return { ok: false, error: 'target_url is required.' }
  let u: URL
  try { u = new URL(raw.trim()) } catch { return { ok: false, error: 'target_url is not a valid URL.' } }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== ZAPIER_HOOK_HOST || u.port || u.username || u.password)
    return { ok: false, error: `target_url must be an https://${ZAPIER_HOOK_HOST} hook URL.` }
  if (!u.pathname.startsWith('/hooks/')) return { ok: false, error: 'target_url is not a Zapier hook path.' }
  return { ok: true, url: u.toString() }
}

/** Does the person who created this key STILL hold `permission` as an active member? (A key must not outlive its creator's rights.) */
export async function keyCreatorHolds(service: any, workspaceId: string, createdBy: string | null, permission: string): Promise<boolean> {
  if (!createdBy) return false
  const { data, error } = await service.from('workspace_members')
    .select('effective_permissions, status').eq('workspace_id', workspaceId).eq('user_id', createdBy).maybeSingle()
  if (error || !data || data.status !== 'active') return false
  return data.effective_permissions?.[permission] === true
}

export const zapierAllowed = (tier: any, lapsed = false) => integrationAllowed('zapier', tier, lapsed)
