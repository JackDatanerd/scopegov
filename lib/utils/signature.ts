// lib/utils/signature.ts
//
// Client signatures arrive as data URLs from the portal's canvas pad and are stored and later
// embedded in the executed PDF by react-pdf. The routes only checked `startsWith('data:image/')`
// and a length cap, so an SVG, a truncated `data:image/png;base64,` or arbitrary bytes were
// accepted — and a signature react-pdf cannot decode makes EVERY later render of that signed
// document throw (the executed SOW/CO could no longer be downloaded at all). Accept only real
// PNG or JPEG data.

export const MAX_SIGNATURE_DATA_LENGTH = 500_000

const PREFIXES = ['data:image/png;base64,', 'data:image/jpeg;base64,']

export function isValidSignatureImage(data: unknown): data is string {
  if (typeof data !== 'string' || data.length > MAX_SIGNATURE_DATA_LENGTH) return false
  const prefix = PREFIXES.find(p => data.startsWith(p))
  if (!prefix) return false
  const b64 = data.slice(prefix.length)
  if (b64.length < 100 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false
  // First 8 raw bytes (12 base64 chars) carry the file signature.
  const head = Buffer.from(b64.slice(0, 16), 'base64')
  if (prefix.includes('png')) {
    return head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  }
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
}
