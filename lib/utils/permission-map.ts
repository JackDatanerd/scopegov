// lib/utils/permission-map.ts
//
// FIX (build — RLS + permissions independent audit, HIGH): permission maps
// (roles.permissions, workspace_members.permission_overrides) were accepted
// from the client as "any JSON object" and stored verbatim. Four different
// layers then read the same jsonb with four different truthiness rules:
//
//   permission-ceiling.ts       === true            (only JSON `true` counts)
//   mfa-policy.ts               === true
//   lib/auth/session.ts         truthy               (1, "yes", {} all grant)
//   update_*_atomic (SQL)       ->> key ::boolean    ('1' / 'yes' / 't' grant,
//                                                     'maybe' raises 22P02)
//
// A MANAGE_ROLES holder could therefore POST a role such as
// `{ DELETE_PROJECTS: 1, MANAGE_BILLING: "yes" }`: the ceiling saw no `true`
// keys and waved it through, then getSession() treated every one of them as
// granted — a full bypass of the delegation ceiling, and (because the MFA
// policy also uses `=== true`) of forced MFA enrolment too. A value like
// "maybe" additionally made every later update_*_atomic call in the workspace
// raise on the boolean cast, bricking role management.
//
// The fix is to make the ONLY representation that can be stored a strict
// { KNOWN_PERMISSION: boolean } object, enforced at every layer:
//   1. this parser at every write route (400 on any non-boolean value),
//   2. migration 064: CHECK constraints + coercion inside the triggers,
//   3. lib/auth/session.ts now reads with `=== true`.

import { ALL_PERMISSIONS } from '@/lib/supabase/types'

const KNOWN = new Set<string>(ALL_PERMISSIONS)

export type PermissionMapResult =
  | { ok: true; value: Record<string, boolean> }
  | { ok: false; error: string }

/**
 * Validate and normalise a client-supplied permission map.
 *  - must be a plain object (not null / array / primitive)
 *  - every value must be a real boolean — anything else is rejected
 *  - keys that aren't a current Permission (a stale key from before a rename,
 *    or garbage) are dropped rather than stored; they never granted anything
 */
export function parsePermissionMap(input: unknown): PermissionMapResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Invalid permissions payload' }
  }
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== 'boolean') {
      return { ok: false, error: `Invalid value for permission ${key}: must be true or false` }
    }
    if (KNOWN.has(key)) out[key] = value
  }
  return { ok: true, value: out }
}

/** True only for a plain object whose every value is a real boolean. */
export function isBooleanPermissionMap(input: unknown): boolean {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  return Object.values(input as Record<string, unknown>).every(v => typeof v === 'boolean')
}
