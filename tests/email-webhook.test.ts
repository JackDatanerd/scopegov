import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyResendSignature, nextEmailStatus } from '@/lib/email/webhook'

const SECRET_RAW = Buffer.from('super-secret-signing-key-for-tests').toString('base64')
const SECRET = `whsec_${SECRET_RAW}`
const NOW = 1_800_000_000_000
const sign = (id: string, ts: string, body: string, secret = SECRET_RAW) =>
  'v1,' + createHmac('sha256', Buffer.from(secret, 'base64')).update(`${id}.${ts}.${body}`).digest('base64')

describe('verifyResendSignature', () => {
  const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 'e1' } })
  const ts = String(Math.floor(NOW / 1000))

  it('accepts a correctly signed, fresh payload', () => {
    expect(verifyResendSignature(body, { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) }, SECRET, NOW)).toBe(true)
  })
  it('accepts the secret with or without the whsec_ prefix', () => {
    expect(verifyResendSignature(body, { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) }, SECRET_RAW, NOW)).toBe(true)
  })
  it('accepts when any of several space-separated signatures matches (secret rotation)', () => {
    const sig = `v1,AAAA ${sign('msg_1', ts, body)}`
    expect(verifyResendSignature(body, { id: 'msg_1', timestamp: ts, signature: sig }, SECRET, NOW)).toBe(true)
  })
  it('rejects a tampered body', () => {
    expect(verifyResendSignature(body + ' ', { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body) }, SECRET, NOW)).toBe(false)
  })
  it('rejects the wrong secret', () => {
    const other = Buffer.from('another-secret').toString('base64')
    expect(verifyResendSignature(body, { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body, other) }, SECRET, NOW)).toBe(false)
  })
  it('rejects a replayed (stale) timestamp even with a valid signature', () => {
    const old = String(Math.floor(NOW / 1000) - 3600)
    expect(verifyResendSignature(body, { id: 'msg_1', timestamp: old, signature: sign('msg_1', old, body) }, SECRET, NOW)).toBe(false)
  })
  it('rejects missing headers, a missing secret, and non-v1 signatures', () => {
    expect(verifyResendSignature(body, { id: null, timestamp: ts, signature: 'v1,x' }, SECRET, NOW)).toBe(false)
    expect(verifyResendSignature(body, { id: 'm', timestamp: ts, signature: null }, SECRET, NOW)).toBe(false)
    expect(verifyResendSignature(body, { id: 'm', timestamp: ts, signature: sign('m', ts, body) }, '', NOW)).toBe(false)
    expect(verifyResendSignature(body, { id: 'm', timestamp: ts, signature: sign('m', ts, body).replace('v1,', 'v2,') }, SECRET, NOW)).toBe(false)
    expect(verifyResendSignature(body, { id: 'm', timestamp: 'abc', signature: sign('m', ts, body) }, SECRET, NOW)).toBe(false)
  })
})

describe('nextEmailStatus — out-of-order and retried events must never downgrade', () => {
  it('advances sent → delivered → bounced', () => {
    expect(nextEmailStatus('sent', 'email.delivered')).toBe('delivered')
    expect(nextEmailStatus('delivered', 'email.bounced')).toBe('bounced')
    expect(nextEmailStatus('sent', 'email.bounced')).toBe('bounced')
    expect(nextEmailStatus('sent', 'email.complained')).toBe('complained')
  })
  it('ignores a late "delivered" after a bounce, and a repeated event', () => {
    expect(nextEmailStatus('bounced', 'email.delivered')).toBeNull()
    expect(nextEmailStatus('bounced', 'email.bounced')).toBeNull()
    expect(nextEmailStatus('delivered', 'email.delivery_delayed')).toBeNull()
  })
  it('ignores events we do not track', () => {
    expect(nextEmailStatus('sent', 'email.opened')).toBeNull()
    expect(nextEmailStatus('sent', 'email.clicked')).toBeNull()
  })
})
