// lib/utils/role-names.ts
//
// Role names are compared exactly (trimmed, case-insensitive) in code rather
// than with a database LIKE pattern, where `%` and `_` in a name act as
// wildcards and can both invent clashes and hide real ones.

export function normalizeRoleName(name: string): string {
  return name.trim().toLowerCase()
}

export function roleNameTaken(
  existing: Array<{ id: string; name: string | null }>,
  candidate: string,
  excludeId?: string,
): boolean {
  const wanted = normalizeRoleName(candidate)
  return existing.some(r => r.id !== excludeId && normalizeRoleName(r.name || '') === wanted)
}
