// tests/settings-independent-pass-17.test.ts
// Settings independent pass 17: workspace name, agency name and the personal full name were cut to 120 characters by
// sanitizeDisplayName and stored behind a 200 "saved". They are refused with a 400 now; the inputs carry maxLength.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { displayNameTooLong, DISPLAY_NAME_MAX } from '@/lib/utils/sanitize'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any

function chain(table: string, ops: Op[] = []): any {
  return new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') return (res: any, rej: any) => { calls.push({ table, ops }); return Promise.resolve(resolver(table, ops)).then(res, rej) }
      return (...args: any[]) => chain(table, [...ops, { name: prop, args }])
    },
  })
}
vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return { ...actual, getSession: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (t: string) => chain(t), auth: { admin: { updateUserById: async () => ({ error: null }) } } }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/auth/security-audit', () => ({ logSecurityAudit: async () => true }))

const isUpdate = (ops: Op[]) => ops.some(o => o.name === 'update')
const row = () => ({
  id: 'w1', name: 'Acme', agency_name: 'Acme', slug: 'acme-x', currency: 'USD', timezone: 'UTC', governing_law: 'Kenya',
  updated_at: '2026-10-01T10:00:00.000+00:00', slug_changed_at: null, onboarding_completed_at: '2026-09-01T00:00:00.000+00:00',
  proactive_risk_threshold: 10000, client_reminder_max: 3, client_reminder_after_days: 3,
})
beforeEach(() => {
  calls.length = 0
  session = { id: 'actor', workspaceId: 'w1', name: 'A', email: 'a@x.com', workspaceName: 'Acme', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
  resolver = (_t, ops) => isUpdate(ops) ? { data: [{ id: 'w1' }], error: null } : { data: row(), error: null }
})

const settings = async (body: any) => {
  const { PATCH } = await import('@/app/api/workspace/settings/route')
  return PATCH(new NextRequest('http://localhost/api/workspace/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
}

describe('displayNameTooLong', () => {
  it('measures the cleaned name', () => {
    expect(displayNameTooLong('a'.repeat(DISPLAY_NAME_MAX))).toBe(false)
    expect(displayNameTooLong('a'.repeat(DISPLAY_NAME_MAX + 1))).toBe(true)
    expect(displayNameTooLong(`  ${'a'.repeat(DISPLAY_NAME_MAX)}   `)).toBe(false)         // padding is trimmed away
    expect(displayNameTooLong(`${'a '.repeat(58)}b    c`)).toBe(false)                       // whitespace runs collapse
    expect(displayNameTooLong('😀'.repeat(61))).toBe(true)                                   // 122 UTF-16 units
  })
})

describe('workspace/settings refuses over-long names', () => {
  it.each(['name', 'agencyName'])('%s of 121 characters is a 400 and nothing is written', async (key) => {
    const res = await settings({ [key]: 'A'.repeat(121) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/120 characters or fewer/)
    expect(calls.some(c => isUpdate(c.ops))).toBe(false)
  })
  it.each(['name', 'agencyName'])('%s of exactly 120 characters is still saved whole', async (key) => {
    const res = await settings({ [key]: 'B'.repeat(120) })
    expect(res.status).toBe(200)
    const col = key === 'name' ? 'name' : 'agency_name'
    expect(calls.find(c => isUpdate(c.ops))?.ops.find(o => o.name === 'update')?.args[0][col]).toBe('B'.repeat(120))
  })
})

describe('workspace/profile refuses an over-long full name', () => {
  const profile = async (name: string) => {
    const { PATCH } = await import('@/app/api/workspace/profile/route')
    return PATCH(new NextRequest('http://localhost/api/workspace/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }))
  }
  it('121 characters is a 400 with no write', async () => {
    const res = await profile('N'.repeat(121))
    expect(res.status).toBe(400)
    expect(calls.some(c => isUpdate(c.ops))).toBe(false)
  })
  it('120 characters is saved whole', async () => {
    resolver = (_t, ops) => isUpdate(ops) ? { data: null, error: null } : { data: { name: 'Old' }, error: null }
    const res = await profile('N'.repeat(120))
    expect(res.status).toBe(200)
    expect(calls.find(c => isUpdate(c.ops))?.ops.find(o => o.name === 'update')?.args[0].name).toBe('N'.repeat(120))
  })
})

describe('Settings inputs carry the same cap', () => {
  const src = readFileSync('components/settings/SettingsClient.tsx', 'utf8')
  it('workspace name, agency name and full name have maxLength 120', () => {
    for (const probe of ["value={form.name}", "value={form.agencyName}", "value={name} onChange"]) {
      const at = src.indexOf(probe)
      expect(at).toBeGreaterThan(0)
      expect(src.slice(Math.max(0, at - 60), at)).toContain('maxLength={120}')
    }
  })
})
