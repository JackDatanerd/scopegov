import { describe, it, expect } from 'vitest'
import { parsePermissionMap, isBooleanPermissionMap } from '@/lib/utils/permission-map'

// Regression coverage for the permission type-confusion escalation (RLS +
// permissions independent audit): roles.permissions / permission_overrides were
// stored as any JSON and read with four different truthiness rules.
describe('parsePermissionMap', () => {
  it('accepts a strict { PERMISSION: boolean } object', () => {
    const r = parsePermissionMap({ VIEW_ALL_PROJECTS: true, EDIT_SOW: false })
    expect(r).toEqual({ ok: true, value: { VIEW_ALL_PROJECTS: true, EDIT_SOW: false } })
  })

  it('accepts an empty object', () => {
    expect(parsePermissionMap({})).toEqual({ ok: true, value: {} })
  })

  it('rejects non-boolean values — the escalation payloads', () => {
    for (const bad of [1, 0, 'yes', 'true', 'false', 'maybe', {}, [], null]) {
      const r = parsePermissionMap({ DELETE_PROJECTS: bad })
      expect(r.ok).toBe(false)
    }
  })

  it('rejects null, arrays and primitives at the top level', () => {
    for (const bad of [null, undefined, [], 'x', 5, true]) {
      expect(parsePermissionMap(bad).ok).toBe(false)
    }
  })

  it('drops unknown keys instead of storing them', () => {
    const r = parsePermissionMap({ MANAGE_ROLES: true, NOT_A_PERMISSION: true, EXPORT_DATA: true })
    expect(r).toEqual({ ok: true, value: { MANAGE_ROLES: true } })
  })

  it('never lets a __proto__ key through', () => {
    const r = parsePermissionMap(JSON.parse('{"__proto__": true, "MANAGE_ROLES": true}'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Object.keys(r.value)).toEqual(['MANAGE_ROLES'])
      expect(({} as any).polluted).toBeUndefined()
    }
  })

  it('reports which permission carried the bad value', () => {
    const r = parsePermissionMap({ MANAGE_BILLING: 'yes' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('MANAGE_BILLING')
  })
})

describe('isBooleanPermissionMap', () => {
  it('matches the SQL is_valid_permission_map() contract', () => {
    expect(isBooleanPermissionMap({})).toBe(true)
    expect(isBooleanPermissionMap({ A: true, B: false })).toBe(true)
    expect(isBooleanPermissionMap({ A: 1 })).toBe(false)
    expect(isBooleanPermissionMap({ A: null })).toBe(false)
    expect(isBooleanPermissionMap([])).toBe(false)
    expect(isBooleanPermissionMap(null)).toBe(false)
  })
})
