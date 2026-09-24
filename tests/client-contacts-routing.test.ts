import { describe, it, expect } from 'vitest'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'

// Records the filter calls and resolves the canned rows when awaited.
function fakeService(rows: any[]) {
  const calls: string[] = []
  const chain: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return (res: any) => res({ data: rows, error: null })
      return (...a: any[]) => { calls.push(`${prop}(${a.join(',')})`); return chain }
    },
  })
  return { service: { from: () => chain }, calls }
}

describe('withPrimaryContactCc', () => {
  it('without a docType only the primary contact is considered (unchanged behaviour)', async () => {
    const { service, calls } = fakeService([{ email: 'pm@acme.com', is_primary: true, role_type: 'other' }])
    expect(await withPrimaryContactCc(service, 'c1', 'jane@acme.com', [])).toEqual(['pm@acme.com'])
    expect(calls.some(c => c.startsWith('eq(is_primary'))).toBe(true)
  })

  it('an invoice also reaches billing contacts', async () => {
    const { service, calls } = fakeService([
      { email: 'pm@acme.com', is_primary: true, role_type: 'other' },
      { email: 'ap@acme.com', is_primary: false, role_type: 'billing' },
    ])
    expect(await withPrimaryContactCc(service, 'c1', 'jane@acme.com', ['fin@acme.com'], 'invoice'))
      .toEqual(['fin@acme.com', 'pm@acme.com', 'ap@acme.com'])
    expect(calls.some(c => c.includes('role_type.in.(billing)'))).toBe(true)
  })

  it('SOWs and change orders reach scope + approver contacts', async () => {
    const { service, calls } = fakeService([])
    await withPrimaryContactCc(service, 'c1', 'jane@acme.com', [], 'co')
    expect(calls.some(c => c.includes('role_type.in.(scope,approver)'))).toBe(true)
  })

  it('never duplicates the client email, an existing CC, or another contact (case-insensitive)', async () => {
    const { service } = fakeService([
      { email: 'JANE@acme.com', is_primary: true }, { email: 'fin@acme.com', is_primary: false, role_type: 'billing' },
      { email: 'Fin@Acme.com', is_primary: false, role_type: 'billing' },
    ])
    expect(await withPrimaryContactCc(service, 'c1', 'jane@acme.com', ['fin@acme.com'], 'invoice')).toEqual(['fin@acme.com'])
  })

  it('a lookup failure never blocks sending', async () => {
    const service = { from: () => { throw new Error('db down') } }
    expect(await withPrimaryContactCc(service, 'c1', 'a@b.co', ['x@y.co'], 'invoice')).toEqual(['x@y.co'])
  })
})
