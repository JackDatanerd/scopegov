import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { loginMessageFromHash, LOGIN_MESSAGES } from '@/lib/auth/login-messages'

// Auth+MFA independent pass 11:
//  B1 mfa-challenge no longer treats a failed listFactors() as "no factor" (redirect loop)
//  B2 resent verification links land on /login, which reads the outcome from the URL fragment
//  B3 /api/auth/signup maps rate-limit / upstream errors instead of echoing raw GoTrue text

let signUpResolver: () => any = () => ({ data: { session: null }, error: null })
vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({ auth: { signUp: async () => signUpResolver() } }),
}))
beforeEach(() => { signUpResolver = () => ({ data: { session: null }, error: null }) })

async function callSignup() {
  const { POST } = await import('@/app/api/auth/signup/route')
  const res = await POST(new NextRequest('http://localhost/api/auth/signup', {
    method: 'POST', body: JSON.stringify({ name: 'Jane Doe', email: 'jane@agency.com', password: 'Tr0ub4dor&3-horse-staple' }),
  }))
  return { status: res.status, json: await res.json() }
}

describe('B3 POST /api/auth/signup error mapping', () => {
  it('429 / rate-limit codes -> friendly 429', async () => {
    signUpResolver = () => ({ data: {}, error: { message: 'email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' } })
    const r = await callSignup()
    expect(r.status).toBe(429)
    expect(r.json.error).not.toMatch(/rate limit exceeded/)
  })
  it('signup_disabled -> 403', async () => {
    signUpResolver = () => ({ data: {}, error: { message: 'Signups not allowed for this instance', status: 422, code: 'signup_disabled' } })
    expect((await callSignup()).status).toBe(403)
  })
  it('upstream 5xx -> generic 502, raw text not leaked', async () => {
    signUpResolver = () => ({ data: {}, error: { message: 'Database error saving new user: relation x', status: 500 } })
    const r = await callSignup()
    expect(r.status).toBe(502)
    expect(JSON.stringify(r.json)).not.toMatch(/Database error/)
  })
  it('weak password keeps GoTrue\'s actionable message (400)', async () => {
    signUpResolver = () => ({ data: {}, error: { message: 'Password is known to be weak and easy to guess, please choose a different one.', status: 422, code: 'weak_password' } })
    const r = await callSignup()
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/weak/)
  })
  it('already registered stays enumeration-safe, by message or by code', async () => {
    signUpResolver = () => ({ data: {}, error: { message: 'User already registered', status: 422 } })
    expect((await callSignup()).json).toEqual({ ok: true, emailSent: true })
    signUpResolver = () => ({ data: {}, error: { message: 'x', status: 422, code: 'user_already_exists' } })
    expect((await callSignup()).json).toEqual({ ok: true, emailSent: true })
  })
})

describe('B2 loginMessageFromHash', () => {
  it('resent-link success fragment -> email_confirmed', () => {
    expect(loginMessageFromHash('#access_token=abc&refresh_token=r&type=signup&expires_in=3600')).toEqual(LOGIN_MESSAGES.email_confirmed)
  })
  it('error fragment -> link_invalid', () => {
    expect(loginMessageFromHash('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid')).toEqual(LOGIN_MESSAGES.link_invalid)
  })
  it('anything else shows nothing (no text is ever taken from the URL)', () => {
    expect(loginMessageFromHash('')).toBeNull()
    expect(loginMessageFromHash(null)).toBeNull()
    expect(loginMessageFromHash('#access_token=abc&type=recovery')).toBeNull()
    expect(loginMessageFromHash('#message=Call+555-0100')).toBeNull()
  })
  it('both resend buttons target /login, not the server callback', () => {
    const login = readFileSync('app/(auth)/login/LoginForm.tsx', 'utf8')
    const signup = readFileSync('app/(auth)/signup/page.tsx', 'utf8')
    expect(login).toMatch(/emailRedirectTo: `\$\{window\.location\.origin\}\/login\?next=/)
    expect(signup).toMatch(/emailRedirectTo: `\$\{window\.location\.origin\}\/login\?next=/)
    expect(login).toContain('loginMessageFromHash')
  })
})

describe('B1 mfa-challenge listFactors failure', () => {
  const src = readFileSync('app/mfa-challenge/page.tsx', 'utf8')
  it('reads the listFactors error and shows a retry state instead of navigating', () => {
    expect(src.match(/error: listErr/g)!.length).toBeGreaterThanOrEqual(2)
    expect(src).toContain('setLoadFailed(true)')
    expect(src).toContain('Try again')
    // the error check precedes the "no verified factor -> router.replace(next)" branch
    expect(src.indexOf('if (listErr)')).toBeLessThan(src.indexOf('router.replace(next.startsWith'))
  })
})
