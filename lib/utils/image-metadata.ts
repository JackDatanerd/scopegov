// lib/utils/image-metadata.ts
//
// FIX (Workspace lifecycle independent pass — B7): profile/avatar stored the uploaded bytes
// exactly as received in the PUBLIC `logos` bucket. A phone photo carries EXIF — GPS position,
// device model, capture time, sometimes a thumbnail of the uncropped original — so uploading
// one as an avatar published all of that at a guessable URL (avatars/<userId>.jpg) that is also
// embedded in emails and shared documents.
//
// This removes it WITHOUT re-encoding (no dependency, no quality loss):
//   JPEG: allow-list — keeps only JFIF (APP0), the ICC colour profile (APP2) and the Adobe marker
//         (APP14) of all the APPn / COM segments, plus everything that affects decoding.
//         The EXIF *orientation* value is kept by writing back a minimal EXIF block that
//         contains only that one tag — dropping it would make portrait phone photos render
//         sideways in browsers that honour it.
//   PNG:  allow-list — keeps only the critical and colour/display/animation chunks a decoder needs;
//         every other chunk (text, EXIF, time, C2PA, vendor/private) is dropped.
// Returns null when the file isn't structurally a valid image of that type, so the caller can
// reject it instead of storing something it couldn't inspect.

// FIX (Workspace lifecycle independent pass 4): this was a deny-list (APP1, APP12-15, COM), so every
// other application segment — APP3-APP11, which is where vendor metadata and the C2PA / content-
// credentials block (APP11, JUMBF) live — passed straight into the public bucket. It is an allow-list
// now: of all the APPn / COM segments only the three a decoder actually needs survive —
//   APP0  'JFIF\0'          (density / aspect ratio)
//   APP2  'ICC_PROFILE\0'   (colour profile). The MPF index (APP2 'MPF\0') is not a profile, so it goes: its offsets point at
//                              secondary images that are removed with the trailing data.
//   APP14 'Adobe'            (colour-transform flag some CMYK/YCCK JPEGs need)
// Everything else — EXIF/XMP (APP1), Photoshop IRB (APP13), vendor APP3-APP11, APP15 and COM — is removed.
// The EXIF orientation value is re-added separately as a minimal block (see buildOrientationApp1).

/** True when this APPn / COM segment is metadata that must not reach the public bucket. */
function isDroppedSegment(buf: Buffer, marker: number, payloadStart: number, segEnd: number): boolean {
  if (marker === 0xfe) return true                                   // COM
  if (marker < 0xe0 || marker > 0xef) return false                   // not an APPn: structural, never dropped
  const startsWith = (tag: string) =>
    segEnd - payloadStart >= tag.length && buf.toString('latin1', payloadStart, payloadStart + tag.length) === tag
  if (marker === 0xe0) return !startsWith('JFIF\0')
  if (marker === 0xe2) return !startsWith('ICC_PROFILE\0')
  if (marker === 0xee) return !startsWith('Adobe')
  return true
}

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

/**
 * FIX (Workspace lifecycle independent pass 2 — B2): after the first SOS the old code copied
 * "the rest verbatim", i.e. EVERYTHING to the end of the file — including whatever follows the
 * image's own EOI. Phone JPEGs routinely carry exactly that: Ultra HDR / MPF secondary images
 * (with their own EXIF), motion-photo video, vendor trailers. So GPS and device data survived
 * the strip into a public bucket. This walks the entropy-coded data and any later scan segments
 * (progressive files) to the FIRST real EOI, drops metadata segments found between scans, and
 * discards everything after. Returns null if no EOI is reached.
 */
function copyScansThroughEoi(buf: Buffer, start: number, out: Buffer[]): boolean {
  let i = start
  let copyFrom = start
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }               // entropy-coded byte
    if (i + 1 >= buf.length) return false
    const m = buf[i + 1]
    if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }   // stuffed 0xFF / RSTn
    if (m === 0xff) { i++; continue }                    // fill byte
    if (m === 0xd9) { out.push(buf.subarray(copyFrom, i + 2)); return true }   // EOI
    if (i + 4 > buf.length) return false
    const len = buf.readUInt16BE(i + 2)
    if (len < 2 || i + 2 + len > buf.length) return false
    if (isDroppedSegment(buf, m, i + 4, i + 2 + len)) {
      out.push(buf.subarray(copyFrom, i))                // metadata between scans: skip it
      copyFrom = i + 2 + len
    }
    i += 2 + len
  }
  return false
}

/**
 * FIX (Workspace lifecycle independent pass 4): the EXIF orientation used to be picked up while the
 * main loop walked the segments, so a file with its ICC profile (APP2) ahead of its EXIF block had
 * already emitted the first non-JFIF segment — and the point where the orientation block goes — before
 * the orientation was known. The block was then never written and a portrait photo came out sideways.
 * Read it in a first pass over the header segments instead.
 */
function findExifOrientation(buf: Buffer): number | null {
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null
    while (i < buf.length && buf[i] === 0xff) i++
    if (i >= buf.length) return null
    const marker = buf[i]; i++
    if (marker === 0xda || marker === 0xd9) return null              // reached the image data
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (i + 2 > buf.length) return null
    const len = buf.readUInt16BE(i)
    if (len < 2 || i + len > buf.length) return null
    if (marker === 0xe1) {
      const o = readExifOrientation(buf.subarray(i + 2, i + len))
      if (o) return o
    }
    i += len
  }
  return null
}

export function stripJpegMetadata(buf: Buffer): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  const out: Buffer[] = [buf.subarray(0, 2)]
  const orientation = findExifOrientation(buf)
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
    if (marker === 0xda) {                                   // SOS: copy scan data up to the first EOI, discard anything after
      insertOrientation()
      out.push(seg)
      return copyScansThroughEoi(buf, i + len, out) ? Buffer.concat(out) : null
    }
    if (!isDroppedSegment(buf, marker, i + 2, i + len)) {
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
// FIX (Workspace lifecycle independent pass 5 — B2): PNG was still a deny-list of five chunks
// (tEXt, zTXt, iTXt, eXIf, tIME) while JPEG moved to an allow-list in pass 4 for the same reason, so
// every OTHER ancillary chunk — the C2PA / Content Credentials chunk (caBX), vendor chunks
// (prVW, iDOT, ...), suggested palettes, private chunks — went into the PUBLIC bucket verbatim.
// Allow-list now: only chunks a decoder needs to draw the image correctly survive.
//   critical:  IHDR PLTE IDAT IEND
//   colour:    tRNS gAMA cHRM sRGB iCCP sBIT cICP mDCV cLLI
//   display:   bKGD hIST pHYs
//   animation: acTL fcTL fdAT (APNG)
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'cICP', 'mDCV', 'cLLI',
  'bKGD', 'hIST', 'pHYs',
  'acTL', 'fcTL', 'fdAT',
])

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
    if (PNG_KEEP.has(type)) out.push(buf.subarray(i, end))
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
