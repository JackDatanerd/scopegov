// Workspace lifecycle independent pass 2: B1 (ambiguous users embed), B2 (JPEG trailing data),
// B3 (delete rollback flag), B4 (profile null body), B5/B6 (avatar route).
import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { NextRequest } from 'next/server'
import { stripJpegMetadata } from '@/lib/utils/image-metadata'

const root = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

const seg = (m: number, payload: Buffer) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = m; b.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([b, payload]) }
const SOI = Buffer.from([0xff, 0xd8])
const EOI = Buffer.from([0xff, 0xd9])
const dqt = seg(0xdb, Buffer.alloc(65, 3))
const sof = seg(0xc0, Buffer.from([8, 0, 8, 0, 8, 1, 1, 0x11, 0]))
const dht = seg(0xc4, Buffer.alloc(20, 7))
const sos = seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0]))
const scan = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78])   // stuffed FF + RST0 inside the scan

describe('B2 JPEG: nothing after the image\'s own EOI survives', () => {
  const trailing = Buffer.concat([
    SOI, seg(0xe1, Buffer.from('Exif\0\0GPS-SECRET', 'latin1')), EOI, Buffer.from('MOTIONVIDEO-SECRET'),
  ])
  it('drops secondary images and trailers (GPS, motion-photo video)', () => {
    const jpg = Buffer.concat([SOI, dqt, sof, sos, scan, EOI, trailing])
    const out = stripJpegMetadata(jpg)!
    expect(out).not.toBeNull()
    expect(out.includes('GPS-SECRET')).toBe(false)
    expect(out.includes('MOTIONVIDEO-SECRET')).toBe(false)
    expect(out.subarray(-2)).toEqual(EOI)
    expect(out.includes(Buffer.concat([sos, scan]))).toBe(true)      // the real scan is intact
  })
  it('does not treat a stuffed FF00 or an RSTn marker in the scan as the end', () => {
    const jpg = Buffer.concat([SOI, dqt, sof, sos, scan, EOI])
    const out = stripJpegMetadata(jpg)!
    expect(out.equals(jpg)).toBe(true)
  })
  it('keeps every scan of a progressive file and drops metadata slipped between scans', () => {
    const sos2 = seg(0xda, Buffer.from([1, 1, 0, 1, 5, 0x10]))
    const scan2 = Buffer.from([0x9a, 0xbc])
    const jpg = Buffer.concat([
      SOI, dqt, sof, dht, sos, scan, seg(0xe1, Buffer.from('Exif\0\0MID-SECRET', 'latin1')), dht, sos2, scan2, EOI, trailing,
    ])
    const out = stripJpegMetadata(jpg)!
    expect(out.includes('MID-SECRET')).toBe(false)
    expect(out.includes('GPS-SECRET')).toBe(false)
    expect(out.includes(Buffer.concat([sos2, scan2]))).toBe(true)
    expect(out.includes(Buffer.concat([sos, scan]))).toBe(true)
    expect(out.subarray(-2)).toEqual(EOI)
  })
  it('drops the MPF index (its offsets point at removed images) but keeps the ICC profile', () => {
    const mpf = seg(0xe2, Buffer.from('MPF\0MPINDEX-SECRET', 'latin1'))
    const icc = seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01abcdef', 'latin1'))
    const out = stripJpegMetadata(Buffer.concat([SOI, mpf, icc, dqt, sof, sos, scan, EOI]))!
    expect(out.includes('MPINDEX-SECRET')).toBe(false)
    expect(out.includes('ICC_PROFILE')).toBe(true)
  })
  it('refuses a file whose scan never reaches an EOI', () => {
    expect(stripJpegMetadata(Buffer.concat([SOI, dqt, sof, sos, scan]))).toBeNull()
  })
})

// ── Route behaviour ────────────────────────────────────────────────────────
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', name: 'Old Name', email: 'a@b.co', workspaceId: 'w1' }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }), auth: { admin: { updateUserById: async () => ({}) } } }),
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))

describe('B4 profile PATCH', () => {
  it('answers 400 (not 500) for a JSON null body, a non-JSON body and a missing name', async () => {
    const { PATCH } = await import('@/app/api/workspace/profile/route')
    for (const body of ['null', 'not json', '{}', '"str"', '[]']) {
      const res = await PATCH(new NextRequest('http://localhost/api/workspace/profile', {
        method: 'PATCH', body, headers: { 'content-type': 'application/json' },
      }))
      expect(res.status, body).toBe(400)
    }
  })
})

describe('B5 avatar POST', () => {
  it('answers 400 (not 500) when the body is not multipart', async () => {
    const { POST } = await import('@/app/api/workspace/profile/avatar/route')
    const res = await POST(new NextRequest('http://localhost/api/workspace/profile/avatar', {
      method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' },
    }))
    expect(res.status).toBe(400)
  })
})

describe('source contracts', () => {
  it('B1: every workspace_members → users notify embed names the user_id constraint and reads its error', () => {
    for (const f of [
      'app/api/workspace/delete/route.ts', 'app/api/workspace/restore/route.ts',
      'app/api/admin/workspaces/[id]/suspend/route.ts', 'app/api/admin/workspaces/[id]/restore/route.ts',
    ]) {
      const src = read(f)
      expect(src, f).not.toMatch(/user:users\(/)
      expect(src, f).toContain('user:users!workspace_members_user_id_fkey(email, name)')
      expect(src, f).toMatch(/could not read members to notify/)
    }
  })
  it('B3: a rolled-back delete clears cancels_at_period_end after a successful resume', () => {
    const src = read('app/api/workspace/delete/route.ts')
    const rollback = src.slice(src.indexOf('resumePaystackSubscription(billing)'))
    expect(rollback.indexOf('cancels_at_period_end: false')).toBeGreaterThan(-1)
    expect(rollback.indexOf('cancels_at_period_end: false')).toBeLessThan(rollback.indexOf('billingRestored = false'))
  })
  it('B6: avatar stale-extension cleanup happens after the users.avatar_url write', () => {
    const src = read('app/api/workspace/profile/avatar/route.ts')
    const post = src.slice(0, src.indexOf('export async function DELETE'))
    expect(post.indexOf('.remove([otherPath])')).toBeGreaterThan(post.indexOf("avatar_url: avatarUrl"))
  })
})
