// tests/settings-independent-pass-1.test.ts
//
// Regression tests for the Settings independent pass (section 5), round 1.
//   B1  workspaces.governing_law is NOT NULL: the defaults route must write '' (never null) when the field is
//       cleared, and migration 124 must remove the silent 'Republic of Kenya' default.
//   B2  the picked-but-unsaved logo File lives in SettingsClient next to its preview, not in BrandingTab.
//   M1  the Guardian tab shows the threshold that was actually saved when the field was blank.
//   M2  the slug cooldown message is formatted in the workspace timezone.
//   M3  the audit log re-resolves a preset date range when the tab regains focus on a new day.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

type Op = { name: string; args: any[] }
let resolver: (table: string, ops: Op[]) => any = () => ({ data: null, error: null })
let session: any

function chain(table: string, ops: Op[] = []): any {
  return new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (res: any, rej: any) => Promise.resolve(resolver(table, ops)).then(res, rej)
      }
      return (...args: any[]) => chain(table, [...ops, { name: prop, args }])
    },
  })
}
const has = (ops: Op[], n: string) => ops.some(o => o.name === n)
const arg = (ops: Op[], n: string) => ops.find(o => o.name === n)?.args

vi.mock('@/lib/auth/session', async () => {
  const actual: any = await vi.importActual('@/lib/auth/session')
  return { ...actual, getSession: async () => session }
})
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (t: string) => chain(t), rpc: async () => ({ data: [], error: null }) }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const req = (url: string, method: string, body?: any) =>
  new NextRequest('http://localhost' + url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const mkSession = (permissions: string[]) => ({
  id: 'actor', workspaceId: 'w1', name: 'Actor', email: 'a@x.com', agencyName: 'Acme', workspaceName: 'Acme', planTier: 'agency', permissions,
})

beforeEach(() => { resolver = () => ({ data: null, error: null }) })

describe('B1 — governing_law is written as empty string, never null, on the NOT NULL workspaces column', () => {
  function run(previous: string | null, governingLaw: string) {
    session = mkSession(['MANAGE_WORKSPACE_SETTINGS'])
    let workspaceUpdate: any = null
    resolver = (t, ops) => {
      if (t === 'workspace_defaults') {
        if (has(ops, 'insert') || has(ops, 'update')) return { error: null }
        return { data: [], error: null }
      }
      if (t === 'workspaces') {
        if (has(ops, 'update')) { workspaceUpdate = arg(ops, 'update')![0]; return { error: null } }
        return { data: { governing_law: previous, sow_language: 'en' }, error: null }
      }
      return { data: null, error: null }
    }
    return import('@/app/api/workspace/defaults/route').then(async ({ POST }) => {
      const res = await POST(req('/api/workspace/defaults', 'POST', { revisionRounds: 2, paymentStructure: '50_50', governingLaw }))
      return { res, workspaceUpdate }
    })
  }

  it("clearing a previously-set governing law writes '' (not null)", async () => {
    const { res, workspaceUpdate } = await run('Republic of Kenya', '')
    expect(res.status).toBe(200)
    expect(workspaceUpdate).not.toBeNull()
    expect(workspaceUpdate.governing_law).toBe('')
  })

  it('an already-blank workspace with a blank field triggers no write at all', async () => {
    const { res, workspaceUpdate } = await run('', '')
    expect(res.status).toBe(200)
    expect(workspaceUpdate).toBeNull()
  })

  it('a real value is written trimmed', async () => {
    const { res, workspaceUpdate } = await run('', '  State of Delaware ')
    expect(res.status).toBe(200)
    expect(workspaceUpdate.governing_law).toBe('State of Delaware')
  })

  it("migration 124 drops the 'Republic of Kenya' default and keeps NOT NULL semantics", () => {
    const sql = read('supabase/migrations/124_workspaces_governing_law_no_default.sql')
    expect(sql).toMatch(/ALTER COLUMN governing_law SET DEFAULT ''/)
    expect(sql).not.toMatch(/DROP NOT NULL/)
  })
})

describe('B2 — pending logo file is lifted alongside its preview', () => {
  const src = read('components/settings/SettingsClient.tsx')
  it('SettingsClient owns logoFile and passes it to BrandingTab', () => {
    expect(src).toMatch(/const \[logoFile, setLogoFile\] = useState<File \| null>\(null\)/)
    expect(src).toMatch(/logoFile=\{logoFile\} setLogoFile=\{setLogoFile\}/)
  })
  it('BrandingTab no longer declares its own logoFile state', () => {
    const branding = src.slice(src.indexOf('function BrandingTab('), src.indexOf('function GuardianTab('))
    expect(branding).not.toMatch(/useState<File \| null>/)
  })
})

describe('M1 — Guardian tab reflects the saved fallback threshold', () => {
  it('writes the fallback back into the input when the field is blank/garbage', () => {
    const src = read('components/settings/SettingsClient.tsx')
    expect(src).toMatch(/set\('riskThreshold', String\(threshold\)\)/)
  })
})

describe('M2 — slug cooldown date uses the workspace timezone', () => {
  it('route formats via formatDateInZone, not toLocaleDateString', () => {
    const src = read('app/api/workspace/settings/route.ts')
    expect(src).toMatch(/formatDateInZone\(nextAllowed, current\.timezone\)/)
    expect(src).not.toMatch(/toLocaleDateString\(\)/)
  })
})

describe('M3 — audit log re-resolves preset ranges on focus', () => {
  it('registers focus/visibilitychange listeners that reset from/to for preset ranges', () => {
    const src = read('components/settings/AuditLogClient.tsx')
    expect(src).toMatch(/addEventListener\('visibilitychange', refreshRange\)/)
    expect(src).toMatch(/addEventListener\('focus', refreshRange\)/)
  })
})
