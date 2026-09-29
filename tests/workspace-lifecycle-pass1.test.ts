// Workspace lifecycle independent pass (round 1): B2/B9/B10 (atomic delete, restore skips deleted
// accounts), B3 (display-name sanitizer), B5 (restore body), B6 (Sidebar),
// B7 (avatar metadata), B8 (copy).
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import {
  stripJpegMetadata, stripPngMetadata, stripImageMetadata, readExifOrientation, buildOrientationApp1,
} from '@/lib/utils/image-metadata'

const root = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

describe('B3 sanitizeDisplayName', () => {
  it('keeps ordinary names, non-Latin names and emoji', () => {
    expect(sanitizeDisplayName('Acme Studio')).toBe('Acme Studio')
    expect(sanitizeDisplayName('日本のデザイン')).toBe('日本のデザイン')
    expect(sanitizeDisplayName('👨‍👩‍👧')).toBe('👨‍👩‍👧')
    expect(sanitizeDisplayName('می\u200Cخواهم')).toBe('می\u200Cخواهم')   // ZWNJ is part of the script
  })
  it('returns empty for names with no visible character', () => {
    for (const blank of ['\u200B\u200B\u200B', '\u200D', '\u200C', '\u3164', '\u2800\u2800', '\u00A0\u00A0', '\uFEFF', '\u115F\u1160'])
      expect(sanitizeDisplayName(blank)).toBe('')
    expect(sanitizeDisplayName(null)).toBe('')
    expect(sanitizeDisplayName(undefined)).toBe('')
  })
  it('strips direction overrides and invisible characters inside a name', () => {
    expect(sanitizeDisplayName('Admin\u202Egnirts')).toBe('Admingnirts')
    expect(sanitizeDisplayName('A\u2066B\u2069')).toBe('AB')
    expect(sanitizeDisplayName('Jo\u200Bhn')).toBe('John')
    expect(sanitizeDisplayName('x\u{E0041}y')).toBe('xy')
    expect(sanitizeDisplayName('a\nb\r\nc')).toBe('a b c')
  })
  it('never leaves half an emoji or a trailing space at the length cap', () => {
    expect(/[\uD800-\uDBFF]$/.test(sanitizeDisplayName('a'.repeat(119) + '😀', 120))).toBe(false)
    expect(sanitizeDisplayName('a'.repeat(118) + ' b', 119).endsWith(' ')).toBe(false)
  })
})

describe('B7 image metadata stripping', () => {
  const seg = (m: number, payload: Buffer) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = m; b.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([b, payload]) }
  function exifLE(orient: number) {
    const tiff = Buffer.alloc(8 + 2 + 3 * 12 + 4 + 40)
    tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(3, 8)
    let e = 10
    tiff.writeUInt16LE(0x010f, e); tiff.writeUInt16LE(2, e + 2); tiff.writeUInt32LE(5, e + 4); tiff.writeUInt32LE(60, e + 8); e += 12
    tiff.writeUInt16LE(0x0112, e); tiff.writeUInt16LE(3, e + 2); tiff.writeUInt32LE(1, e + 4); tiff.writeUInt16LE(orient, e + 8); e += 12
    tiff.writeUInt16LE(0x8825, e); tiff.writeUInt16LE(4, e + 2); tiff.writeUInt32LE(1, e + 4); tiff.writeUInt32LE(70, e + 8)
    tiff.write('GPSLAT-SECRET-1.2345N', 70, 'latin1')
    return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  }
  const jfif = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'))
  const icc = seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01abcdef', 'latin1'))
  const dqt = seg(0xdb, Buffer.alloc(65, 3))
  const sof = seg(0xc0, Buffer.from([8, 0, 8, 0, 8, 1, 1, 0x11, 0]))
  const sos = seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0]))
  const scan = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56])
  const build = (orient: number) => Buffer.concat([
    Buffer.from([0xff, 0xd8]), jfif, seg(0xe1, exifLE(orient)),
    seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>gps</x:xmpmeta>', 'latin1')),
    seg(0xfe, Buffer.from('comment-secret')), icc, dqt, sof, sos, scan, Buffer.from([0xff, 0xd9]),
  ])

  it('removes EXIF/GPS, XMP and comments from a JPEG but keeps what decoding needs', () => {
    const out = stripJpegMetadata(build(6))!
    expect(out).not.toBeNull()
    for (const secret of ['GPSLAT-SECRET', 'xmpmeta', 'comment-secret']) expect(out.includes(secret)).toBe(false)
    expect(out.includes('JFIF')).toBe(true)
    expect(out.includes('ICC_PROFILE')).toBe(true)
    expect(out.includes(Buffer.concat([sos, scan]))).toBe(true)
    expect(out.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]))
  })
  it('preserves the EXIF orientation (and only that) so portrait photos stay upright', () => {
    const out = stripJpegMetadata(build(6))!
    let app1: Buffer | null = null
    for (let i = 2; i < out.length - 4; i++) if (out[i] === 0xff && out[i + 1] === 0xe1) { app1 = out.subarray(i + 4, i + 2 + out.readUInt16BE(i + 2)); break }
    expect(app1).not.toBeNull()
    expect(readExifOrientation(app1!)).toBe(6)
    expect(app1!.length).toBeLessThan(40)
    expect(out.indexOf('Exif')).toBeLessThan(out.indexOf(dqt))
    expect(stripJpegMetadata(build(1))!.includes('Exif')).toBe(false)     // upright → nothing to keep
    expect(readExifOrientation(buildOrientationApp1(8).subarray(4))).toBe(8)
  })
  it('keeps the Adobe colour-transform marker', () => {
    const adobe = seg(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x02', 'latin1'))
    const out = stripJpegMetadata(Buffer.concat([Buffer.from([0xff, 0xd8]), adobe, dqt, sof, sos, scan, Buffer.from([0xff, 0xd9])]))!
    expect(out.includes('Adobe')).toBe(true)
  })
  it('refuses files it cannot parse', () => {
    expect(stripJpegMetadata(Buffer.from('hello world'))).toBeNull()
    expect(stripJpegMetadata(build(6).subarray(0, 60))).toBeNull()
    expect(stripJpegMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1, 2, 3]))).toBeNull()
    expect(readExifOrientation(Buffer.from('Exif\0\0garbage-garbage'))).toBeNull()
  })
  it('strips text/EXIF/time chunks from a PNG and keeps the image chunks', () => {
    const crc = Buffer.alloc(4)
    const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); return Buffer.concat([l, Buffer.from(type, 'latin1'), data, crc]) }
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', Buffer.alloc(13, 1)),
      chunk('tEXt', Buffer.from('Author\0SECRET-NAME')), chunk('eXIf', Buffer.from('GPS-SECRET')), chunk('tIME', Buffer.alloc(7)),
      chunk('iCCP', Buffer.from('icc')), chunk('IDAT', Buffer.from('pixels')), chunk('IEND', Buffer.alloc(0))])
    const out = stripPngMetadata(png)!
    expect(out.includes('SECRET')).toBe(false)
    expect(out.includes('tIME')).toBe(false)
    expect(out.includes('iCCP') && out.includes('pixels')).toBe(true)
    expect(stripPngMetadata(Buffer.from('nope'))).toBeNull()
    expect(stripPngMetadata(png.subarray(0, png.length - 12))).toBeNull()
    expect(stripImageMetadata('image/gif', png)).toBeNull()
  })
})

describe('source contracts', () => {
  it('B2/B9: delete goes through delete_workspace_atomic, resumes billing on failure, and never re-stamps', () => {
    const route = read('app/api/workspace/delete/route.ts')
    expect(route).toContain("rpc('delete_workspace_atomic'")
    expect(route).toContain('resumePaystackSubscription')
    expect(route).toContain('already_deleted')
    expect(route).not.toMatch(/\.from\('workspaces'\)\s*\.update\(\{ deleted_at: now \}\)/)
    expect(route).not.toContain('pickFallbackMembership')
  })
  it('migration 116: lock, second-delete refusal, active-only deactivation, deleted-account guard on both restores', () => {
    const sql = read('supabase/migrations/116_workspace_delete_atomic_restore_skips_deleted_accounts.sql')
    expect(sql).toContain('FOR UPDATE')
    expect(sql).toContain("RAISE EXCEPTION 'already_deleted'")
    expect(sql).toContain("RAISE EXCEPTION 'blocked_by_live_documents'")
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.delete_workspace_atomic(uuid, timestamptz) FROM PUBLIC, anon, authenticated')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.delete_workspace_atomic(uuid, timestamptz) TO service_role')
    const guards = sql.match(/u\.deleted_at IS NOT NULL/g) || []
    expect(guards.length).toBeGreaterThanOrEqual(2)          // restore_workspace_atomic + admin_restore_workspace
    expect(sql).toMatch(/wm\.user_id IS NOT NULL AND wm\.joined_at IS NOT NULL/)   // 112's invariant survives the rewrite
  })
  it('B5: restore validates the body and the id', () => {
    const src = read('app/api/workspace/restore/route.ts')
    expect(src).toContain('.catch(() => null)')
    expect(src).toContain('workspaceId is not valid')
  })
  it('B6: Sidebar reports failed switches instead of ignoring them', () => {
    const src = read('components/layout/Sidebar.tsx')
    const at = src.indexOf('async function switchWorkspace')
    expect(src.slice(at, at + 1500)).toContain('alert(')
  })
  it('B7: avatar route strips metadata before uploading', () => {
    const src = read('app/api/workspace/profile/avatar/route.ts')
    expect(src).toContain("stripImageMetadata(file.type, buffer)")
    expect(src.indexOf('stripImageMetadata(file.type')).toBeLessThan(src.indexOf('.upload(path'))
  })
  it('B8: delete copy no longer says the workspace is unrecoverable', () => {
    expect(read('components/settings/SettingsClient.tsx')).not.toContain('Delete workspace permanently')
    expect(read('app/onboarding/page.tsx')).not.toContain('can\\u2019t be undone.\'')
  })
  it('migration numbers are unique and 116 exists', () => {
    const files = fs.readdirSync(path.join(root, 'supabase/migrations')).filter(f => /^\d+_/.test(f))
    const nums = files.map(f => parseInt(f, 10))
    expect(new Set(nums).size).toBe(nums.length)
    expect(files.some(f => f.startsWith('116_workspace_delete_atomic'))).toBe(true)
  })
})
