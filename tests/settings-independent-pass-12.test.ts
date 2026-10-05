// tests/settings-independent-pass-12.test.ts
//
// Settings independent pass 12:
//  1. invisible-only text (zero-width / bidi / control characters) counted as a value — governing law included, which
//     then passed the SOW generate hard-block and the validate-send "section is empty" checks
//  2. logo DELETE answered 200 when its workspace read FAILED; POST ignored the same failed read
//  3. the Guardian risk threshold showed unredacted to audit viewers without VIEW_FINANCIALS
//  4. approval pickers showed blank names
//  5. non-string address parts were dropped, loosely-typed numbers ([5], '12abc') were accepted
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { redactMetadata } from '@/lib/audit/redact'

type Op = { name: string; args: any[] }
const calls: Array<{ table: string; ops: Op[] }> = []
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any
let storageRemoved: string[][] = []

function chain(table: string, ops: Op[] = []): any {
  return new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (res: any, rej: any) => {
          calls.push({ table, ops })
          return Promise.resolve(resolver(table, ops)).then(res, rej)
        }
      }
      return (...args: any[]) => chain(table, [...ops, { name: prop, args }])
    },
  })
}

vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return { ...actual, getSession: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (t: string) => chain(t),
    storage: { from: () => ({ remove: async (p: string[]) => { storageRemoved.push(p); return { error: null } } }) },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))

const isUpdate = (ops: Op[]) => ops.some(o => o.name === 'update')
const updatePayload = () => calls.find(c => isUpdate(c.ops))?.ops.find(o => o.name === 'update')?.args[0]
const row = (extra: any = {}) => ({
  id: 'w1', name: 'Acme', slug: 'acme', reply_to_email: null, currency: 'USD', timezone: 'UTC', governing_law: 'Republic of Kenya',
  tax_id: '123', phone: '555', website: 'a.com', default_payment_instructions: 'x', legal_address: { city: 'Old' },
  updated_at: '2026-10-01T10:00:00.000+00:00', slug_changed_at: null, onboarding_completed_at: '2026-09-01T00:00:00.000+00:00',
  proactive_risk_threshold: 10000, client_reminder_max: 3, client_reminder_after_days: 3, logo_storage_path: 'w1/logo.png', ...extra,
})
const patch = async (body: any) => {
  const { PATCH } = await import('@/app/api/workspace/settings/route')
  return PATCH(new NextRequest('http://localhost/api/workspace/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  calls.length = 0; storageRemoved = []
  session = { id: 'actor', workspaceId: 'w1', name: 'A', email: 'a@x.com', workspaceName: 'Acme', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
  resolver = (_t, ops) => isUpdate(ops) ? { data: [{ id: 'w1' }], error: null } : { data: row(), error: null }
})

describe('1. invisible-only text is blank', () => {
  it('governing law made of zero-width characters is stored as unset (empty), not as a value', async () => {
    const res = await patch({ governingLaw: '\u200b\u2060\u202e' })
    expect(res.status).toBe(200)
    expect(updatePayload().governing_law).toBe('')
  })
  it.each(['taxId', 'phone', 'website', 'defaultPaymentInstructions'])('%s of only invisible characters clears to null', async (k) => {
    const res = await patch({ [k]: '\u200b\u200b' })
    expect(res.status).toBe(200)
    const col = { taxId: 'tax_id', phone: 'phone', website: 'website', defaultPaymentInstructions: 'default_payment_instructions' }[k as string]!
    expect(updatePayload()[col]).toBeNull()
  })
  it('an address part of only invisible characters is dropped; real parts are kept', async () => {
    const res = await patch({ legalAddress: { line1: '\u200b', city: 'Nairobi' } })
    expect(res.status).toBe(200)
    expect(updatePayload().legal_address).toEqual({ city: 'Nairobi' })
  })
  it('a visible governing law is untouched', async () => {
    const res = await patch({ governingLaw: 'England and Wales' })
    expect(res.status).toBe(200)
    expect(updatePayload().governing_law).toBe('England and Wales')
  })
  it('the defaults route, SOW generate and validate-send all test blankness with isBlankText', () => {
    expect(readFileSync('app/api/workspace/defaults/route.ts', 'utf8')).toMatch(/isBlankText\(governingLawValue\)/)
    expect(readFileSync('app/api/sow/generate/route.ts', 'utf8')).toMatch(/isBlankText\(governingLawRaw\)/)
    const v = readFileSync('lib/sow/validate-send.ts', 'utf8')
    for (const sec of ['parties', 'governing_law', 'signature'])
      expect(v).toContain(`isBlankText(textOf(byId('${sec}')?.content))`)
  })
})

describe('5. loose typing', () => {
  it('a non-string address part is a 400, not silently dropped', async () => {
    const res = await patch({ legalAddress: { line1: 123 } })
    expect(res.status).toBe(400)
    expect(updatePayload()).toBeUndefined()
  })
  it.each([[{ proactiveRiskThreshold: '12abc' }], [{ proactiveRiskThreshold: [5] }], [{ clientReminderMax: [5] }], [{ defaultTaxRate: [5] }]])(
    'rejects %j', async (body) => {
      const res = await patch(body)
      expect(res.status).toBe(400)
      expect(updatePayload()).toBeUndefined()
    })
  it('still accepts real numbers and numeric strings', async () => {
    expect((await patch({ proactiveRiskThreshold: '2500.5', clientReminderMax: '4', defaultTaxRate: 16 })).status).toBe(200)
  })
})

describe('2. logo routes and a failed workspace read', () => {
  const del = async () => {
    const { DELETE } = await import('@/app/api/workspace/branding/logo/route')
    return DELETE(new NextRequest('http://localhost/api/workspace/branding/logo', { method: 'DELETE' }))
  }
  it('DELETE answers 500 — not 200 "nothing to remove" — when the read fails, and deletes nothing', async () => {
    resolver = () => ({ data: null, error: { message: 'db down' } })
    const res = await del()
    expect(res.status).toBe(500)
    expect(storageRemoved).toEqual([])
    expect(calls.some(c => isUpdate(c.ops))).toBe(false)
  })
  it('DELETE with no logo on record is still a harmless 200', async () => {
    resolver = () => ({ data: { logo_storage_path: null }, error: null })
    expect((await del()).status).toBe(200)
  })
  it('POST refuses before uploading when the current-logo read fails', () => {
    const src = readFileSync('app/api/workspace/branding/logo/route.ts', 'utf8')
    const readAt = src.indexOf('existingErr')
    expect(readAt).toBeGreaterThan(0)
    expect(readAt).toBeLessThan(src.indexOf('.upload(path'))
  })
})

describe('3. audit redaction', () => {
  const md = { fields: [], changes: {
    proactiveRiskThreshold: { from: 10000, to: 250000 },
    defaultTaxRate: { from: 0, to: 16 },
    defaultPaymentTermsDays: { from: 7, to: 30 },
  } }
  it('hides the risk threshold from viewers without VIEW_FINANCIALS but keeps the day count and tax rate', () => {
    const out: any = redactMetadata(md, false)
    expect(out.changes.proactiveRiskThreshold).toBe('[redacted]')
    expect(out.changes.defaultPaymentTermsDays).toEqual({ from: 7, to: 30 })
    expect(out.changes.defaultTaxRate).toEqual({ from: 0, to: 16 })
  })
  it('financial viewers see everything', () => {
    expect((redactMetadata(md, true) as any).changes.proactiveRiskThreshold).toEqual({ from: 10000, to: 250000 })
  })
})

describe('4. approvals names', () => {
  it('falls back to the email when a member or step user has no name', () => {
    expect(readFileSync('app/(app)/settings/approvals/page.tsx', 'utf8')).toContain('name: m.users.name || m.users.email')
    expect(readFileSync('components/settings/ApprovalWorkflowsClient.tsx', 'utf8')).toContain("s.user?.name || s.user?.email || '—'")
  })
})
