// lib/integrations/hubspot-config.ts
//
// HubSpot OAuth configuration for the CRM sync. Server-only.
//
//   HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET   from a HubSpot developer-portal app (developers.hubspot.com -> Apps). Its redirect URL
//                                               must be exactly ${NEXT_PUBLIC_APP_URL}/api/integrations/hubspot/callback and its
//                                               scopes must match HUBSPOT_SCOPES below.
//
// SCOPES — only what a one-way contact / company / deal sync needs. No custom-property or schema scopes: ScopeGov keeps its own
// record of what it created (integration_external_refs) instead of adding properties to the customer's HubSpot.

import { signOAuthState, verifyOAuthState, type OAuthState, type StateCheck } from './oauth-state'

export const HUBSPOT_AUTH_URL = 'https://app.hubspot.com/oauth/authorize'
export const HUBSPOT_API = 'https://api.hubapi.com'
export const HUBSPOT_TOKEN_URL = `${HUBSPOT_API}/oauth/v1/token`
export const HUBSPOT_SCOPES = [
  'crm.objects.contacts.read', 'crm.objects.contacts.write',
  'crm.objects.companies.read', 'crm.objects.companies.write',
  'crm.objects.deals.read', 'crm.objects.deals.write',
] as const

export const hubspotConfigured = (env: NodeJS.ProcessEnv = process.env) => !!(env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET)

export function hubspotRedirectUri(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = (env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
  return /^https?:\/\//.test(base) ? `${base}/api/integrations/hubspot/callback` : null
}

export function hubspotAuthorizeUrl(state: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const redirect = hubspotRedirectUri(env)
  if (!hubspotConfigured(env) || !redirect) return null
  const q = new URLSearchParams({ client_id: env.HUBSPOT_CLIENT_ID!, redirect_uri: redirect, scope: HUBSPOT_SCOPES.join(' '), state })
  return `${HUBSPOT_AUTH_URL}?${q}`
}

export const signHubspotState = (s: OAuthState, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): string => signOAuthState('hubspot', s, nowMs, env)
export const verifyHubspotState = (t: string | null | undefined, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): StateCheck => verifyOAuthState('hubspot', t, nowMs, env)

/** Where to open a synced record in HubSpot. 0-1 contact, 0-2 company, 0-3 deal. */
export const hubspotRecordUrl = (hubId: string | number, kind: 'contact' | 'company' | 'deal', id: string) =>
  `https://app.hubspot.com/contacts/${encodeURIComponent(String(hubId))}/record/${{ contact: '0-1', company: '0-2', deal: '0-3' }[kind]}/${encodeURIComponent(id)}`

// ── what the sync does, per event ────────────────────────────────────────────
/** The events the HubSpot rule can act on, and the permission to ask for each (same rule as every integration). */
export const HUBSPOT_EVENT_PERMISSIONS: Record<string, string> = {
  'sow.signed': 'SEND_SOW',
  'sow.declined': 'SEND_SOW',
  'change_order.accepted': 'SEND_CHANGE_ORDERS',
  'guardian.flag_raised': 'APPROVE_FLAGS',
  'invoice.paid': 'VIEW_FINANCIALS',
}
export const HUBSPOT_EVENT_LABELS: Record<string, string> = {
  'sow.signed': 'SOW signed (deal → Closed won)',
  'sow.declined': 'SOW declined (deal → Closed lost)',
  'change_order.accepted': 'Change order accepted (note)',
  'guardian.flag_raised': 'Scope flag raised (note)',
  'invoice.paid': 'Payment received (note)',
}
export const HUBSPOT_BACKFILL_LIMIT = 200
export const HUBSPOT_BACKFILL_COOLDOWN_MS = 10 * 60 * 1000
