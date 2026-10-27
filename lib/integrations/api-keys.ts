// lib/integrations/api-keys.ts
//
// Workspace API keys (used first by Zapier). Format `sgk_` + 32 random bytes (base64url). Only the SHA-256 of the key
// is stored — the secret is shown to its creator exactly once — plus a short visible prefix to tell keys apart.
// Keys are high-entropy random strings, so a fast hash is appropriate (nothing to brute-force).

import { createHash, randomBytes } from 'node:crypto'
import { effectivePlanTier, isWorkspaceLapsed } from '@/lib/billing/plans'
import { integrationAllowed } from './plans'

export const API_KEY_PREFIX = 'sgk_'

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString('base64url')
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 6), hash: hashApiKey(key) }
}

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex')

export function extractBearerKey(authorization: string | null): string | null {
  const m = /^Bearer\s+(sgk_[A-Za-z0-9_-]{43})$/.exec((authorization || '').trim())
  return m ? m[1] : null
}

export interface ApiKeyAuth { workspaceId: string; keyId: string; createdBy: string | null }

/** Resolves the workspace a request's API key belongs to, or null (wrong/revoked/expired key, plan or workspace not eligible). */
export async function authenticateApiKey(service: any, authorization: string | null, nowMs: number = Date.now()): Promise<ApiKeyAuth | null> {
  const key = extractBearerKey(authorization)
  if (!key) return null
  const { data: row, error } = await service.from('integration_api_keys')
    .select('id, workspace_id, created_by, expires_at, revoked_at, last_used_at').eq('key_hash', hashApiKey(key)).maybeSingle()
  if (error || !row || row.revoked_at) return null
  if (row.expires_at && Date.parse(row.expires_at) <= nowMs) return null

  const { data: ws } = await service.from('workspaces').select('plan_tier, trial_ends_at, lapsed_at, deleted_at').eq('id', row.workspace_id).maybeSingle()
  if (!ws || ws.deleted_at) return null
  if (!integrationAllowed('api_keys', effectivePlanTier(ws.plan_tier, ws.trial_ends_at, nowMs), isWorkspaceLapsed(ws.plan_tier, ws.trial_ends_at, ws.lapsed_at, nowMs))) return null

  // last_used_at is informational: write it at most once a minute so a busy integration is not a write per request.
  if (!row.last_used_at || nowMs - Date.parse(row.last_used_at) > 60_000)
    await service.from('integration_api_keys').update({ last_used_at: new Date(nowMs).toISOString() }).eq('id', row.id)
  return { workspaceId: row.workspace_id, keyId: row.id, createdBy: row.created_by ?? null }
}
