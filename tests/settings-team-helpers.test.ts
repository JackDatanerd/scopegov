import { describe, it, expect } from 'vitest'
import { isValidTimeZone, resolveTimeZone, formatDateTimeInZone, formatDateInZone, timeZoneLabel } from '@/lib/utils/timezone'
import { normalizeSlug, validateSlug } from '@/lib/utils/slug'
import { diffFields, sameValue } from '@/lib/utils/audit-diff'
import { parseStandardsInput, pickAgencyStandards, CLAUSES_MAX, CLAUSE_MAX, STANDARD_TEXT_MAX } from '@/lib/utils/agency-standards'
import { roleNameTaken } from '@/lib/utils/role-names'
import { diffPermissionMaps, diffOverrides } from '@/lib/utils/permission-diff'
import { avatarPaths } from '@/lib/utils/avatar-storage'
import { AUDIT_CATEGORIES } from '@/lib/audit/categories'

describe('isValidTimeZone', () => {
  it('accepts zones the canonical-name list omits (Asia/Kolkata, UTC)', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Africa/Nairobi')).toBe(true)
    expect(isValidTimeZone('Asia/Calcutta')).toBe(true)
  })
  it('rejects junk and non-strings', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone(undefined)).toBe(false)
    expect(isValidTimeZone(42)).toBe(false)
    expect(isValidTimeZone('x'.repeat(100))).toBe(false)
  })
  it('falls back to UTC when unset or invalid', () => {
    expect(resolveTimeZone('')).toBe('UTC')
    expect(resolveTimeZone(null)).toBe('UTC')
    expect(resolveTimeZone('nope')).toBe('UTC')
    expect(resolveTimeZone('Africa/Nairobi')).toBe('Africa/Nairobi')
  })
})

describe('workspace-timezone formatting', () => {
  const instant = '2026-09-21T22:30:00Z'
  it('renders the instant in the zone and labels it', () => {
    const nairobi = formatDateTimeInZone(instant, 'Africa/Nairobi')
    expect(nairobi).toMatch(/22 Sep(t)? 2026/)   // 22:30Z is already the next day at UTC+3
    expect(nairobi).toContain('01:30')
    const utc = formatDateTimeInZone(instant, 'UTC')
    expect(utc).toMatch(/21 Sep(t)? 2026/)
    expect(utc).toContain('22:30')
    expect(utc).toContain('UTC')
  })
  it('handles missing or bad input', () => {
    expect(formatDateTimeInZone(null, 'UTC')).toBe('—')
    expect(formatDateTimeInZone('not a date', 'UTC')).toBe('—')
    expect(formatDateInZone(instant, 'Africa/Nairobi')).toMatch(/^22 Sep(t)? 2026$/)
    expect(timeZoneLabel('UTC')).toBe('UTC')
  })
})

describe('workspace handle rules', () => {
  it('normalizes', () => {
    expect(normalizeSlug('  My Agency!! ')).toBe('my-agency')
    expect(normalizeSlug('a---b')).toBe('a-b')
    expect(normalizeSlug('-x-')).toBe('x')
  })
  it('enforces length and reserved words', () => {
    expect(validateSlug('ab').ok).toBe(false)
    expect(validateSlug('---').ok).toBe(false)
    expect(validateSlug('x'.repeat(41)).ok).toBe(false)
    expect(validateSlug('Settings').ok).toBe(false)
    expect(validateSlug('acme-studio')).toEqual({ ok: true, value: 'acme-studio' })
  })
})

describe('audit diff', () => {
  it('reports only real changes with from/to', () => {
    const { changedKeys, changes } = diffFields({ name: 'A', currency: 'USD' }, { name: 'B', currency: 'USD' })
    expect(changedKeys).toEqual(['name'])
    expect(changes.name).toEqual({ from: 'A', to: 'B' })
  })
  it('redacts values for sensitive keys', () => {
    const { changes } = diffFields({ taxId: '1' }, { taxId: '2' }, ['taxId'])
    expect(changes.taxId).toEqual({ changed: true })
  })
  it('treats blank/null as equal and ignores object key order', () => {
    expect(sameValue(null, '')).toBe(true)
    expect(sameValue(undefined, null)).toBe(true)
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(sameValue(3, '3')).toBe(true)
    expect(sameValue('a', 'b')).toBe(false)
  })
  it('clips very long values', () => {
    const { changes } = diffFields({ x: '' }, { x: 'z'.repeat(500) })
    expect(String((changes.x as any).to).length).toBeLessThan(260)
  })
})

describe('agency standards', () => {
  it('parses and trims lists, dropping blanks', () => {
    const r = parseStandardsInput({ outOfScopeClauses: [' Hosting ', '', 'Licences'], revisionPolicy: '  ' })
    expect(r).toEqual({ ok: true, values: { out_of_scope_clauses: ['Hosting', 'Licences'], revision_policy: null } })
  })
  it('leaves absent fields alone and clears with null/empty', () => {
    expect(parseStandardsInput({})).toEqual({ ok: true, values: {} })
    expect(parseStandardsInput({ assumptions: [] })).toEqual({ ok: true, values: { assumptions: null } })
    expect(parseStandardsInput({ paymentTerms: null })).toEqual({ ok: true, values: { payment_terms: null } })
  })
  it('enforces the limits the SOW generator keeps', () => {
    expect(parseStandardsInput({ outOfScopeClauses: Array(CLAUSES_MAX + 1).fill('x') }).ok).toBe(false)
    expect(parseStandardsInput({ assumptions: ['y'.repeat(CLAUSE_MAX + 1)] }).ok).toBe(false)
    expect(parseStandardsInput({ revisionPolicy: 'z'.repeat(STANDARD_TEXT_MAX + 1) }).ok).toBe(false)
    expect(parseStandardsInput({ outOfScopeClauses: 'nope' }).ok).toBe(false)
    expect(parseStandardsInput({ revisionPolicy: 5 }).ok).toBe(false)
  })
  it('a project-type row inherits standards it does not set from the workspace row', () => {
    const rows = [
      { project_type: null, revision_policy: 'Global policy', out_of_scope_clauses: ['Hosting'], payment_terms: null, assumptions: null },
      { project_type: 'web', revision_policy: null, out_of_scope_clauses: null, payment_terms: 'Net 7', assumptions: ['Content supplied'] },
    ]
    expect(pickAgencyStandards(rows, 'web')).toEqual({
      revisionPolicy: 'Global policy', paymentTerms: 'Net 7', outOfScopeClauses: ['Hosting'], assumptions: ['Content supplied'],
    })
    expect(pickAgencyStandards(rows, 'brand')?.revisionPolicy).toBe('Global policy')
  })
  it('returns null when nothing is set', () => {
    expect(pickAgencyStandards([], 'web')).toBeNull()
    expect(pickAgencyStandards([{ project_type: null }], 'web')).toBeNull()
    expect(pickAgencyStandards(null, null)).toBeNull()
  })
})

describe('role names', () => {
  const roles = [{ id: '1', name: 'Editor' }, { id: '2', name: 'Sales_Lead' }]
  it('compares exactly, case-insensitively, ignoring surrounding space', () => {
    expect(roleNameTaken(roles, '  editor ')).toBe(true)
    expect(roleNameTaken(roles, 'Viewer')).toBe(false)
  })
  it('treats % and _ literally, not as wildcards', () => {
    expect(roleNameTaken(roles, '%')).toBe(false)
    expect(roleNameTaken(roles, 'SalesXLead')).toBe(false)
    expect(roleNameTaken(roles, 'sales_lead')).toBe(true)
  })
  it('lets a role keep its own name', () => {
    expect(roleNameTaken(roles, 'Editor', '1')).toBe(false)
  })
})

describe('permission diffs', () => {
  it('lists what a role edit granted and revoked', () => {
    expect(diffPermissionMaps({ A: true, B: true }, { B: true, C: true })).toEqual({ granted: ['C'], revoked: ['A'] })
    expect(diffPermissionMaps({}, { A: true })).toEqual({ granted: ['A'], revoked: [] })
    expect(diffPermissionMaps({ A: true }, { A: false })).toEqual({ granted: [], revoked: ['A'] })
  })
  it('describes override transitions per key', () => {
    expect(diffOverrides({ A: true }, { A: false, B: true })).toEqual({
      A: { from: 'grant', to: 'revoke' }, B: { from: 'inherit', to: 'grant' },
    })
    expect(diffOverrides({ A: true }, { A: true })).toEqual({})
    expect(diffOverrides({ A: true }, null)).toEqual({ A: { from: 'grant', to: 'inherit' } })
  })
})

describe('avatar storage + audit categories', () => {
  it('covers every stored avatar variant', () => {
    expect(avatarPaths('u1')).toEqual(['avatars/u1.png', 'avatars/u1.jpg'])
  })
  it('files role creation under Team & roles as well as new role events', () => {
    const team = AUDIT_CATEGORIES.find(c => c.id === 'team')!
    expect(team.patterns).toContain('role.%')
    expect(team.patterns).toContain('workspace.role_created')
  })
})
