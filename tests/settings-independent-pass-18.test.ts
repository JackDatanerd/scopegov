// tests/settings-independent-pass-18.test.ts
//
// Settings independent pass 18:
//  1. the audit-log date range was cut at the VIEWER's browser-local midnights while every row is rendered in the
//     WORKSPACE timezone, so a teammate in another zone saw range edges that split days differently from the times
//     on screen. Range days are now the workspace's calendar days (zonedDayStart / zonedDayEnd / zonedDateDaysAgo).
//  2. logo upload cleanup used the path read before the upload, so two simultaneous PNG/JPG uploads left the loser's
//     object orphaned in the public bucket. Cleanup now re-reads the link after writing it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { zonedDayStart, zonedDayEnd, zonedDateDaysAgo } from '@/lib/utils/timezone'

describe('1. workspace-zone calendar days', () => {
  it('Nairobi (+3, no DST): the day starts at 21:00Z the evening before and ends 20:59:59.999Z', () => {
    expect(zonedDayStart('2026-10-06', 'Africa/Nairobi')!.toISOString()).toBe('2026-10-05T21:00:00.000Z')
    expect(zonedDayEnd('2026-10-06', 'Africa/Nairobi')!.toISOString()).toBe('2026-10-06T20:59:59.999Z')
  })
  it('New York across both DST changes (23h and 25h days)', () => {
    expect(zonedDayStart('2026-03-08', 'America/New_York')!.toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(zonedDayEnd('2026-03-08', 'America/New_York')!.toISOString()).toBe('2026-03-09T03:59:59.999Z')
    expect(zonedDayStart('2026-11-01', 'America/New_York')!.toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(zonedDayEnd('2026-11-01', 'America/New_York')!.toISOString()).toBe('2026-11-02T04:59:59.999Z')
  })
  it('a zone west of UTC and a missing/invalid zone (UTC fallback)', () => {
    expect(zonedDayStart('2026-10-06', 'Pacific/Honolulu')!.toISOString()).toBe('2026-10-06T10:00:00.000Z')
    expect(zonedDayStart('2026-10-06', null)!.toISOString()).toBe('2026-10-06T00:00:00.000Z')
    expect(zonedDayEnd('2026-10-06', 'Not/AZone')!.toISOString()).toBe('2026-10-06T23:59:59.999Z')
  })
  it('malformed and impossible dates are null', () => {
    expect(zonedDayStart('', 'UTC')).toBeNull()
    expect(zonedDayStart('2026-10-6', 'UTC')).toBeNull()
    expect(zonedDayStart('2026-02-30', 'UTC')).toBeNull()
    expect(zonedDayEnd('nope', 'UTC')).toBeNull()
  })
  it('"today" and "N days ago" follow the workspace zone, not the machine', () => {
    const now = new Date('2026-10-05T22:00:00Z') // 5 Oct in UTC and New York, already 6 Oct in Nairobi
    expect(zonedDateDaysAgo(0, 'Africa/Nairobi', now)).toBe('2026-10-06')
    expect(zonedDateDaysAgo(0, 'America/New_York', now)).toBe('2026-10-05')
    expect(zonedDateDaysAgo(30, 'Africa/Nairobi', now)).toBe('2026-09-06')
    expect(zonedDateDaysAgo(90, 'UTC', new Date('2026-03-01T12:00:00Z'))).toBe('2025-12-01')
  })
  it('AuditLogClient builds its range from the workspace zone, not browser-local dates', () => {
    const src = readFileSync('components/settings/AuditLogClient.tsx', 'utf8')
    expect(src).toMatch(/zonedDayStart\(from, timeZone\)/)
    expect(src).toMatch(/zonedDayEnd\(to, timeZone\)/)
    expect(src).not.toMatch(/startOfLocalDay|endOfLocalDay|daysAgoLocal|getFullYear\(\)/)
  })
})

type Op = { name: string; args: any[] }
let session: any
let reads: Array<string | null>
let storageRemoved: string[][]
let uploaded: string[]

function chain(table: string, ops: Op[] = []): any {
  return new Proxy(function () {}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (res: any, rej: any) => {
          const isUpdate = ops.some(o => o.name === 'update')
          const out = table === 'workspaces' && !isUpdate
            ? { data: { logo_storage_path: reads.shift() ?? null }, error: null }
            : { data: [{ id: 'w1' }], error: null }
          return Promise.resolve(out).then(res, rej)
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
    storage: {
      from: () => ({
        upload: async (p: string) => { uploaded.push(p); return { error: null } },
        remove: async (p: string[]) => { storageRemoved.push(p); return { error: null } },
      }),
    },
  }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

async function upload() {
  const { POST } = await import('@/app/api/workspace/branding/logo/route')
  const fd = new FormData()
  fd.set('file', new File([PNG], 'logo.png', { type: 'image/png' }))
  return POST(new NextRequest('http://localhost/api/workspace/branding/logo', { method: 'POST', body: fd }))
}

beforeEach(() => {
  storageRemoved = []; uploaded = []; reads = []
  session = { id: 'actor', workspaceId: 'w1', name: 'A', email: 'a@x.com', workspaceName: 'Acme', permissions: ['MANAGE_WORKSPACE_SETTINGS'] }
})

describe('2. logo upload cleanup re-reads the link after writing it', () => {
  it('a concurrent upload of the other type linked after us: our own object is the orphan and is removed', async () => {
    reads = [null, 'w1/logo.jpg'] // before upload: no logo; after our link: the other admin's JPG
    const res = await upload()
    expect(res.status).toBe(200)
    expect(uploaded).toEqual(['w1/logo.png'])
    expect(storageRemoved).toEqual([['w1/logo.png']])
  })
  it('ordinary type switch: the previous object is removed, the new one kept', async () => {
    reads = ['w1/logo.jpg', 'w1/logo.png']
    expect((await upload()).status).toBe(200)
    expect(storageRemoved).toEqual([['w1/logo.jpg']])
  })
  it('previous object that someone has since re-linked is never deleted', async () => {
    reads = ['w1/logo.jpg', 'w1/logo.jpg'] // after our link the row points at the JPG again (other admin was later)
    expect((await upload()).status).toBe(200)
    expect(storageRemoved).toEqual([['w1/logo.png']]) // ours is the orphan; their JPG is untouched
  })
  it('same-path replacement removes nothing', async () => {
    reads = ['w1/logo.png', 'w1/logo.png']
    expect((await upload()).status).toBe(200)
    expect(storageRemoved).toEqual([])
  })
})
