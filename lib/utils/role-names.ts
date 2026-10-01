// lib/utils/role-names.ts
//
// Role names are compared exactly (trimmed, case-insensitive) in code rather
// than with a database LIKE pattern, where `%` and `_` in a name act as
// wildcards and can both invent clashes and hide real ones.

import { sanitizeDisplayName } from '@/lib/utils/sanitize'

// FIX (Team & Invites independent pass): this only trimmed and lower-cased, so "Designer" and "Designer" + a
// zero-width space (or a Hangul filler) compared as DIFFERENT names — and the database's own unique index
// (lower(btrim(name))) doesn't treat those characters as blank either. Two visually identical roles could be
// created, which is exactly the ambiguity the uniqueness rule exists to prevent (role pickers identify a role
// by name alone). Compare on the sanitized form, the same one role routes now store.
export function normalizeRoleName(name: string): string {
  return sanitizeDisplayName(name, 1000).toLowerCase()
}

export function roleNameTaken(
  existing: Array<{ id: string; name: string | null }>,
  candidate: string,
  excludeId?: string,
): boolean {
  const wanted = normalizeRoleName(candidate)
  return existing.some(r => r.id !== excludeId && normalizeRoleName(r.name || '') === wanted)
}
