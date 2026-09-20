import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SignJWT } from 'jose'

vi.mock('@/lib/utils/workspace-secret', () => ({
  getWorkspaceJwtSecret: vi.fn(async () => 'test-secret-test-secret-test-secret-1234'),
  isWorkspaceDeleted: vi.fn(async () => false),
}))
import { resolveInvoiceToken } from '@/lib/documents/invoice-token'
import { isWorkspaceDeleted } from '@/lib/utils/workspace-secret'

const secret = new TextEncoder().encode('test-secret-test-secret-test-secret-1234')
const mint = (exp: number | string) => new SignJWT({ invoiceId: 'inv1' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime(exp).sign(secret)

// service stub: revoked_tokens and invoices tables, matched by the .eq() calls the resolver makes
function service(opts: { revoked?: any; byToken?: any; byId?: any }) {
  return {
    from(table: string) {
      const filters: Record<string, any> = {}
      const b: any = {
        select: () => b,
        eq: (col: string, val: any) => { filters[col] = val; return b },
        maybeSingle: async () => {
          if (table === 'revoked_tokens') return { data: opts.revoked ?? null }
          if ('token' in filters) return { data: opts.byToken ?? null }
          if ('id' in filters) return { data: opts.byId ?? null }
          return { data: null }
        },
      }
      return b
    },
  }
}
const inv = (status: string) => ({ id: 'inv1', status, workspace_id: 'w1' })

beforeEach(() => vi.mocked(isWorkspaceDeleted).mockResolvedValue(false))

describe('resolveInvoiceToken', () => {
  it('accepts a valid live token', async () => {
    const t = await mint('1h')
    const r = await resolveInvoiceToken(service({ byToken: inv('sent') }), t, 'id')
    expect(r).toMatchObject({ ok: true, viaSuperseded: false })
  })
  it('a revoked token (any reason but superseded) is 410', async () => {
    const r = await resolveInvoiceToken(service({ revoked: { reason: 'manual' } }), 'x', 'id')
    expect(r).toEqual({ ok: false, status: 410, error: 'Link no longer active' })
  })
  it('a SUPERSEDED token resolves to the live invoice by id (the renewal cron rotated the emailed link)', async () => {
    const r = await resolveInvoiceToken(service({ revoked: { reason: 'superseded', document_id: 'inv1' }, byId: inv('overdue') }), 'old-token', 'id')
    expect(r).toMatchObject({ ok: true, viaSuperseded: true })
  })
  it('unknown token is 404', async () => {
    expect(await resolveInvoiceToken(service({}), 'nope', 'id')).toMatchObject({ ok: false, status: 404 })
  })
  it('void and draft invoices are 409', async () => {
    const t = await mint('1h')
    expect(await resolveInvoiceToken(service({ byToken: inv('void') }), t, 'id')).toMatchObject({ ok: false, status: 409 })
    expect(await resolveInvoiceToken(service({ byToken: inv('draft') }), t, 'id')).toMatchObject({ ok: false, status: 409 })
  })
  it('an EXPIRED JWT is tolerated for a live invoice, but not for anything else', async () => {
    const expired = await mint(Math.floor(Date.now() / 1000) - 60)
    expect(await resolveInvoiceToken(service({ byToken: inv('overdue') }), expired, 'id')).toMatchObject({ ok: true })
  })
  it('a badly-signed token is 401', async () => {
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode('another-secret-another-secret-12345678'))
    expect(await resolveInvoiceToken(service({ byToken: inv('sent') }), forged, 'id')).toMatchObject({ ok: false, status: 401 })
  })
  it('a deleted workspace is 410', async () => {
    vi.mocked(isWorkspaceDeleted).mockResolvedValue(true)
    const t = await mint('1h')
    expect(await resolveInvoiceToken(service({ byToken: inv('sent') }), t, 'id')).toMatchObject({ ok: false, status: 410 })
  })
})
