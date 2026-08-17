import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import type { NextRequest } from 'next/server'

function fakeRequest(authHeader: string | null): NextRequest {
  return {
    headers: { get: (key: string) => (key.toLowerCase() === 'authorization' ? authHeader : null) },
  } as unknown as NextRequest
}

describe('verifyCronSecret', () => {
  const originalSecret = process.env.CRON_SECRET

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret
  })

  it('accepts the correct bearer token', () => {
    process.env.CRON_SECRET = 'super-secret-value'
    expect(verifyCronSecret(fakeRequest('Bearer super-secret-value'))).toBe(true)
  })

  it('rejects a wrong token', () => {
    process.env.CRON_SECRET = 'super-secret-value'
    expect(verifyCronSecret(fakeRequest('Bearer wrong-value'))).toBe(false)
  })

  it('rejects a missing Authorization header', () => {
    process.env.CRON_SECRET = 'super-secret-value'
    expect(verifyCronSecret(fakeRequest(null))).toBe(false)
  })

  // FIX (audit round 3, finding #6) regression: with CRON_SECRET unset,
  // the naive `auth === \`Bearer ${secret}\`` comparison degrades to
  // `auth === "Bearer undefined"` — a literal string anyone can send.
  // This must stay rejected even if a request happens to send exactly
  // that string.
  it('rejects everything — including the literal "Bearer undefined" string — when CRON_SECRET is unset', () => {
    delete process.env.CRON_SECRET
    expect(verifyCronSecret(fakeRequest('Bearer undefined'))).toBe(false)
    expect(verifyCronSecret(fakeRequest(null))).toBe(false)
  })

  it('rejects an empty-string CRON_SECRET the same way as unset', () => {
    process.env.CRON_SECRET = ''
    expect(verifyCronSecret(fakeRequest('Bearer '))).toBe(false)
  })
})
