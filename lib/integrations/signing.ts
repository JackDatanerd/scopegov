// lib/integrations/signing.ts
//
// Webhook signing. Each delivery carries
//   X-ScopeGov-Timestamp: unix seconds
//   X-ScopeGov-Signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
// Receivers recompute it over the RAW request body and reject timestamps older than a few minutes (replay).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export function generateSigningSecret(): string {
  return 'whsec_' + randomBytes(32).toString('base64url')
}

export function signPayload(secret: string, timestamp: number | string, body: string): string {
  return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

/** What a receiver runs. Exported for the docs and the tests; the app itself only signs. */
export function verifySignature(
  secret: string, timestamp: string | null, body: string, header: string | null,
  toleranceSeconds = 300, nowMs: number = Date.now(),
): boolean {
  if (!secret || !timestamp || !header) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false
  const expected = Buffer.from(signPayload(secret, timestamp, body))
  return header.split(' ').some(candidate => {
    const got = Buffer.from(candidate.trim())
    return got.length === expected.length && timingSafeEqual(got, expected)
  })
}
