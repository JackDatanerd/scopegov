// lib/utils/file-signature.ts
//
// Shared file-type validation for anything stored in the private
// `flag-evidence` bucket: an allowlist of MIME types this app accepts as
// evidence, plus a magic-byte check for the types that have a reliable
// signature (guards against a declared Content-Type that doesn't match the
// actual bytes — see the original comment on MAGIC_BYTES below).
//
// FIX (independent pass round 2, section 13): this lived only in
// app/api/scope-governance/.../attachments/route.ts (the manual
// flag/exception evidence upload). guardian/inbound now also saves real
// attachment bytes from an inbound email (migration 083 —
// guardian_check_attachments) instead of only the filename; factored this
// out so that second write path applies the exact same check instead of
// re-typing the allowlist and magic-byte table a second time — the last
// time this codebase had two hand-copies of the same small security check
// (escapeLike, see lib/utils/escape-like.ts), one of the two silently broke
// and nobody noticed until this same audit round.
export const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
  'message/rfc822', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])

// FIX (audit round 3): `file.type` on a browser File/FormData object is
// whatever the client claims — trivially spoofable (rename evil.html to
// evil.png, or just construct the multipart part by hand). It was being
// used as BOTH the allowlist check and the stored object's Content-Type,
// so a spoofed type could get real HTML/SVG content stored with a
// mismatched Content-Type header. Exploitability was already limited here
// (private bucket, signed-URL download, nothing inlines these), but it's
// a free check to add: verify the file's actual leading bytes match a
// magic number for the type it claims to be before trusting it. Only the
// binary types below have a reliable signature — text/plain and
// message/rfc822 have none, so those still rely on the declared type,
// same as before.
const MAGIC_BYTES: Record<string, (buf: Buffer) => boolean> = {
  'application/pdf':  buf => buf.subarray(0, 4).toString('latin1') === '%PDF',
  'image/png':        buf => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg':       buf => buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/webp':       buf => buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP',
  // .docx is a zip container (PK\x03\x04) — this only confirms "is a zip",
  // not "is specifically a valid docx", which is enough to rule out
  // someone mislabeling an arbitrary non-zip file as this type.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    buf => buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
}

export function matchesDeclaredType(mimeType: string, buf: Buffer): boolean {
  const check = MAGIC_BYTES[mimeType]
  return check ? check(buf) : true // text/plain, message/rfc822 — no reliable signature to check
}
