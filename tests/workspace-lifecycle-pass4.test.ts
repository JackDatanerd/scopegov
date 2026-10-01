// Workspace lifecycle independent pass 4 — avatar JPEG metadata allow-list.
import { describe, it, expect } from 'vitest'
import { stripJpegMetadata, readExifOrientation, buildOrientationApp1 } from '@/lib/utils/image-metadata'

const seg = (m: number, payload: Buffer) => { const b = Buffer.alloc(4); b[0] = 0xff; b[1] = m; b.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([b, payload]) }
const SOI = Buffer.from([0xff, 0xd8])
const EOI = Buffer.from([0xff, 0xd9])
const jfif = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'))
const icc = seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01abcdef', 'latin1'))
const dqt = seg(0xdb, Buffer.alloc(65, 3))
const sof = seg(0xc0, Buffer.from([8, 0, 8, 0, 8, 1, 1, 0x11, 0]))
const sos = seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0]))
const scan = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56])
const exif6 = seg(0xe1, buildOrientationApp1(6).subarray(4))

describe('JPEG strip is an allow-list', () => {
  it('drops APP3-APP11 / APP15 vendor and content-credential segments', () => {
    const app11 = seg(0xeb, Buffer.from('JP\0\0c2pa-DEVICE-SECRET', 'latin1'))
    const app3 = seg(0xe3, Buffer.from('Meta\0\0VENDOR-GPS-SECRET', 'latin1'))
    const app15 = seg(0xef, Buffer.from('APP15-SECRET', 'latin1'))
    const out = stripJpegMetadata(Buffer.concat([SOI, jfif, app3, app11, app15, dqt, sof, sos, scan, EOI]))!
    for (const s of ['DEVICE-SECRET', 'VENDOR-GPS-SECRET', 'APP15-SECRET']) expect(out.includes(s)).toBe(false)
    expect(out.includes('JFIF')).toBe(true)
    expect(out.includes(Buffer.concat([sos, scan]))).toBe(true)
  })
  it('drops such a segment slipped between scans of a progressive file', () => {
    const sos2 = seg(0xda, Buffer.from([1, 1, 0, 1, 5, 0x10]))
    const app11 = seg(0xeb, Buffer.from('MIDSCAN-SECRET', 'latin1'))
    const out = stripJpegMetadata(Buffer.concat([SOI, dqt, sof, sos, scan, app11, sos2, Buffer.from([0x9a]), EOI]))!
    expect(out.includes('MIDSCAN-SECRET')).toBe(false)
    expect(out.includes(sos2)).toBe(true)
  })
  it('keeps JFIF, ICC_PROFILE and Adobe; drops JFXX thumbnails', () => {
    const adobe = seg(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x02', 'latin1'))
    const jfxx = seg(0xe0, Buffer.from('JFXX\0THUMB-SECRET', 'latin1'))
    const out = stripJpegMetadata(Buffer.concat([SOI, jfif, jfxx, icc, adobe, dqt, sof, sos, scan, EOI]))!
    expect(out.includes('JFIF')).toBe(true)
    expect(out.includes('ICC_PROFILE')).toBe(true)
    expect(out.includes('Adobe')).toBe(true)
    expect(out.includes('THUMB-SECRET')).toBe(false)
  })
})

describe('JPEG orientation survives whatever the segment order', () => {
  const orientationOf = (out: Buffer) => {
    for (let i = 2; i < out.length - 4; i++) if (out[i] === 0xff && out[i + 1] === 0xe1) return readExifOrientation(out.subarray(i + 4, i + 2 + out.readUInt16BE(i + 2)))
    return null
  }
  it('keeps it when EXIF comes before the ICC profile', () => {
    expect(orientationOf(stripJpegMetadata(Buffer.concat([SOI, jfif, exif6, icc, dqt, sof, sos, scan, EOI]))!)).toBe(6)
  })
  it('keeps it when the ICC profile comes BEFORE the EXIF block', () => {
    expect(orientationOf(stripJpegMetadata(Buffer.concat([SOI, jfif, icc, exif6, dqt, sof, sos, scan, EOI]))!)).toBe(6)
  })
  it('writes no EXIF at all for an upright (1) or orientation-less photo', () => {
    const exif1 = seg(0xe1, buildOrientationApp1(1).subarray(4))
    expect(stripJpegMetadata(Buffer.concat([SOI, jfif, icc, exif1, dqt, sof, sos, scan, EOI]))!.includes('Exif')).toBe(false)
    expect(stripJpegMetadata(Buffer.concat([SOI, jfif, icc, dqt, sof, sos, scan, EOI]))!.includes('Exif')).toBe(false)
  })
})
