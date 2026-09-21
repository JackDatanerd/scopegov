// lib/utils/permission-diff.ts
//
// What a change to a role's permissions (or a member's overrides) actually
// granted and revoked, for the audit trail: the question an auditor asks is
// "who was given MANAGE_BILLING", not "a role was edited".

type PermMap = Record<string, unknown> | null | undefined

const granted = (map: PermMap, key: string) => !!map && map[key] !== false && map[key] !== null && map[key] !== undefined

export function diffPermissionMaps(before: PermMap, after: PermMap): { granted: string[]; revoked: string[] } {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})])
  const gained: string[] = []
  const lost: string[] = []
  for (const key of Array.from(keys).sort()) {
    const was = granted(before, key)
    const now = granted(after, key)
    if (!was && now) gained.push(key)
    if (was && !now) lost.push(key)
  }
  return { granted: gained, revoked: lost }
}

/**
 * Overrides are tri-state (inherit / always grant / always revoke), so a change
 * is described per key rather than as granted/revoked.
 */
export function diffOverrides(before: PermMap, after: PermMap): Record<string, { from: string; to: string }> {
  const state = (map: PermMap, key: string) => (!map || map[key] === undefined || map[key] === null) ? 'inherit' : (map[key] ? 'grant' : 'revoke')
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})])
  const out: Record<string, { from: string; to: string }> = {}
  for (const key of Array.from(keys).sort()) {
    const from = state(before, key)
    const to = state(after, key)
    if (from !== to) out[key] = { from, to }
  }
  return out
}
