import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripPngMetadata } from '@/lib/utils/image-metadata'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const chunk = (type: string, data: Buffer) => {
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length)
  return Buffer.concat([l, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}

describe('B2: PNG metadata strip is an allow-list', () => {
  const png = Buffer.concat([
    SIG, chunk('IHDR', Buffer.alloc(13, 1)),
    chunk('caBX', Buffer.from('C2PA-SECRET-CLAIM')),
    chunk('prVW', Buffer.from('VENDOR-SECRET')),
    chunk('sPLT', Buffer.from('PALETTE-SECRET')),
    chunk('tEXt', Buffer.from('Author\0TEXT-SECRET')),
    chunk('eXIf', Buffer.from('EXIF-SECRET')),
    chunk('tIME', Buffer.alloc(7)),
    chunk('gAMA', Buffer.alloc(4)), chunk('sRGB', Buffer.alloc(1)), chunk('pHYs', Buffer.alloc(9)),
    chunk('tRNS', Buffer.alloc(2)), chunk('iCCP', Buffer.from('icc')),
    chunk('acTL', Buffer.alloc(8)), chunk('fcTL', Buffer.alloc(26)), chunk('fdAT', Buffer.from('frame')),
    chunk('IDAT', Buffer.from('pixels')), chunk('IEND', Buffer.alloc(0)),
  ])
  const out = stripPngMetadata(png)!
  it('drops private / vendor / provenance chunks the old deny-list let through', () => {
    for (const secret of ['SECRET', 'caBX', 'prVW', 'sPLT', 'tEXt', 'eXIf', 'tIME']) expect(out.includes(secret), secret).toBe(false)
  })
  it('keeps every chunk needed to draw the image identically', () => {
    for (const t of ['IHDR', 'gAMA', 'sRGB', 'pHYs', 'tRNS', 'iCCP', 'acTL', 'fcTL', 'fdAT', 'IDAT', 'IEND']) expect(out.includes(t), t).toBe(true)
    expect(out.includes('pixels')).toBe(true)
  })
  it('still refuses truncated input', () => {
    expect(stripPngMetadata(png.subarray(0, png.length - 12))).toBeNull()
  })
})

describe('B2 (traced): logo upload strips metadata before storing, like the avatar route', () => {
  const src = read('app/api/workspace/branding/logo/route.ts')
  it('strips before upload and refuses an unparseable file', () => {
    expect(src).toContain('stripImageMetadata(file.type, buffer)')
    expect(src.indexOf('stripImageMetadata(file.type')).toBeLessThan(src.indexOf('.upload(path'))
    expect(src).toContain('looks damaged')
  })
})

describe('B1: workspace-open lands with a hard navigation', () => {
  const src = read('components/workspace/WorkspaceOpenClient.tsx')
  it('uses window.location, not the soft router, so the (app) layout re-renders for the new workspace', () => {
    expect(src).toContain("window.location.replace('/dashboard')")
    expect(src).not.toContain('router.replace')
    expect(src).not.toContain('useRouter')
  })
  it('page comment no longer claims the page works without an onboarded active workspace', () => {
    expect(read('app/(app)/workspace-open/page.tsx')).not.toMatch(/deliberately does NOT require the\s*\/\/\s*CURRENT active workspace/)
  })
})
