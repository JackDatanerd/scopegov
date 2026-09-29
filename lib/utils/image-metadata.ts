// lib/utils/image-metadata.ts
//
// FIX (Workspace lifecycle independent pass — B7): profile/avatar stored the uploaded bytes
// exactly as received in the PUBLIC `logos` bucket. A phone photo carries EXIF — GPS position,
// device model, capture time, sometimes a thumbnail of the uncropped original — so uploading
// one as an avatar published all of that at a guessable URL (avatars/<userId>.jpg) that is also
// embedded in emails and shared documents.
//
// This removes it WITHOUT re-encoding (no dependency, no quality loss):
//   JPEG: drops APP1 (EXIF / XMP), APP12/13 (Photoshop IRB, Ducky), APP14-15 and COM segments.
//         JFIF (APP0), ICC colour profile (APP2) and everything that affects decoding stay.
//         The EXIF *orientation* value is kept by writing back a minimal EXIF block that
//         contains only that one tag — dropping it would make portrait phone photos render
//         sideways in browsers that honour it.
//   PNG:  drops the ancillary text/time/EXIF chunks (tEXt, zTXt, iTXt, eXIf, tIME).
// Returns null when the file isn't structurally a valid image of that type, so the caller can
// reject it instead of storing something it couldn't inspect.

const JPEG_DROP = new Set([0xe1, 0xec, 0xed, 0xee, 0xef, 0xfe]) // APP1, APP12, APP13, APP14, APP15, COM
// Note APP14 (Adobe) carries a colour-transform flag some CMYK/YCCK JPEGs need; it is re-added below.

/** Read the EXIF orientation (1-8) out of an APP1 payload (starting at "Exif\0\0"), or null. */
export function readExifOrientation(app1: Buffer): number | null {
  try {
    if (app1.length < 14 || app1.toString('latin1', 0, 6) !== 'Exif\0\0') return null
    const tiff = app1.subarray(6)
    const little = tiff.toString('latin1', 0, 2) === 'II'
    if (!little && tiff.toString('latin1', 0, 2) !== 'MM') return null
    const u16 = (o: number) => little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o)
    const u32 = (o: number) => little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o)
    if (u16(2) !== 42) return null
    const ifd = u32(4)
    if (ifd < 8 || ifd + 2 > tiff.length) return null
    const count = u16(ifd)
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12
      if (e + 12 > tiff.length) return null
      if (u16(e) === 0x0112) {
        const v = u16(e + 8)
        return v >= 1 && v <= 8 ? v : null
      }
    }
    return null
  } catch { return null }
}

/** A complete APP1 segment holding nothing but the orientation tag. */
export function buildOrientationApp1(orientation: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4)
  tiff.write('MM', 0, 'latin1')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)            // IFD0 at offset 8
  tiff.writeUInt16BE(1, 8)            // one entry
  tiff.writeUInt16BE(0x0112, 10)      // Orientation
  tiff.writeUInt16BE(3, 12)           // type SHORT
  tiff.writeUInt32BE(1, 14)           // count 1
  tiff.writeUInt16BE(orientation, 18) // value (left-justified in the 4-byte field)
  tiff.writeUInt32BE(0, 22)           // no next IFD
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const seg = Buffer.alloc(4)
  seg[0] = 0xff; seg[1] = 0xe1
  seg.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([seg, payload])
}

export function stripJpegMetadata(buf: Buffer): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  const out: Buffer[] = [buf.subarray(0, 2)]
  let orientation: number | null = null
  let insertedOrientation = false
  let i = 2
  const insertOrientation = () => {
    if (!insertedOrientation && orientation && orientation !== 1) out.push(buildOrientationApp1(orientation))
    insertedOrientation = true
  }
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null
    while (i < buf.length && buf[i] === 0xff) i++            // fill bytes
    if (i >= buf.length) return null
    const marker = buf[i]; i++
    if (marker === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); return Buffer.concat(out) }   // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { out.push(Buffer.from([0xff, marker])); continue } // no length
    if (i + 2 > buf.length) return null
    const len = buf.readUInt16BE(i)
    if (len < 2 || i + len > buf.length) return null
    const seg = buf.subarray(i - 2, i + len)                 // includes FF + marker + length + payload
    if (marker === 0xda) {                                   // SOS: entropy-coded data follows; copy the rest verbatim
      insertOrientation()
      out.push(seg, buf.subarray(i + len))
      return Buffer.concat(out)
    }
    if (marker === 0xe1) {
      const o = readExifOrientation(buf.subarray(i + 2, i + len))
      if (o && orientation === null) orientation = o
    }
    if (JPEG_DROP.has(marker)) {
      // Keep the Adobe colour-transform marker: without it CMYK/YCCK files decode with wrong colours.
      if (marker === 0xee && buf.toString('latin1', i + 2, i + 7) === 'Adobe') out.push(seg)
    } else {
      // Put the orientation block right after JFIF/first segment position: before the first
      // frame/table segment (anything that is not APP0).
      if (marker !== 0xe0) insertOrientation()
      out.push(seg)
    }
    i += len
  }
  return null // no EOI/SOS reached: truncated
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])

export function stripPngMetadata(buf: Buffer): Buffer | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  const out: Buffer[] = [buf.subarray(0, 8)]
  let i = 8
  let sawIend = false
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('latin1', i + 4, i + 8)
    const end = i + 12 + len
    if (end > buf.length) return null
    if (!PNG_DROP.has(type)) out.push(buf.subarray(i, end))
    i = end
    if (type === 'IEND') { sawIend = true; break }
  }
  return sawIend ? Buffer.concat(out) : null
}

export function stripImageMetadata(mime: string, buf: Buffer): Buffer | null {
  if (mime === 'image/jpeg') return stripJpegMetadata(buf)
  if (mime === 'image/png') return stripPngMetadata(buf)
  return null
}
