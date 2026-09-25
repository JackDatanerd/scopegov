// tests/signup.test.ts
//
// Regression test for the Auth+MFA re-pass finding: signup used to call
// supabase.auth.signUp() straight from the browser, so validatePassword()
// (the common-password blocklist / email-match check / 72-byte cap) was
// only ever an advisory client-side pre-check a caller could route around
// entirely by hitting Supabase directly with the public anon key. The
// fix moves account creation server-side (POST /api/auth/signup) so
// validatePassword() is the actual gate. The key assertion here is
// negative: for a policy-violating password, signUp must never be
// called at all — not just that the response contains an error.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

let signUpCalls: any[] = []
let signUpResolver: (args: any) => any = () => ({ data: { session: null }, error: null })

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({
    auth: {
      signUp: async (args: any) => {
        signUpCalls.push(args)
        return signUpResolver(args)
      },
    },
  }),
}))

beforeEach(() => {
  signUpCalls = []
  signUpResolver = () => ({ data: { session: null }, error: null })
})

async function callSignup(body: any) {
  const { POST } = await import('@/app/api/auth/signup/route')
  const req = new NextRequest('http://localhost/api/auth/signup', {
    method: 'POST', body: JSON.stringify(body),
  })
  const res = await POST(req)
  return { status: res.status, json: await res.json() }
}

describe('POST /api/auth/signup — authoritative password policy', () => {
  it('rejects a common password and never calls signUp', async () => {
    const { status, json } = await callSignup({ name: 'Jane Doe', email: 'jane@agency.com', password: 'Password123' })
    expect(status).toBe(400)
    expect(json.error).toBeTruthy()
    expect(signUpCalls.length).toBe(0)
  })

  it('rejects a password matching the account email and never calls signUp', async () => {
    const { status } = await callSignup({ name: 'Jane Doe', email: 'jane.doe@agency.com', password: 'jane.doe@agency.com' })
    expect(status).toBe(400)
    expect(signUpCalls.length).toBe(0)
  })

  it('rejects a password over the 72-byte bcrypt cap and never calls signUp', async () => {
    const { status } = await callSignup({ name: 'Jane Doe', email: 'jane@agency.com', password: 'a'.repeat(73) })
    expect(status).toBe(400)
    expect(signUpCalls.length).toBe(0)
  })

  it('requires a name and never calls signUp when missing', async () => {
    const { status } = await callSignup({ name: '', email: 'jane@agency.com', password: 'correct horse battery' })
    expect(status).toBe(400)
    expect(signUpCalls.length).toBe(0)
  })

  it('accepts a policy-passing signup and calls signUp exactly once with terms_version stamped', async () => {
    const { status, json } = await callSignup({ name: 'Jane Doe', email: 'jane@agency.com', password: 'correct horse battery' })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.emailSent).toBe(true)
    expect(signUpCalls.length).toBe(1)
    expect(signUpCalls[0].email).toBe('jane@agency.com')
    expect(signUpCalls[0].options.data.name).toBe('Jane Doe')
    expect(signUpCalls[0].options.data.terms_version).toBeTruthy()
  })

  it('treats "already registered" as a successful-looking response (enumeration-safe)', async () => {
    signUpResolver = () => ({ data: { session: null }, error: { message: 'User already registered' } })
    const { status, json } = await callSignup({ name: 'Jane Doe', email: 'jane@agency.com', password: 'correct horse battery' })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.emailSent).toBe(true)
  })

  it('surfaces a real signUp error otherwise', async () => {
    signUpResolver = () => ({ data: { session: null }, error: { message: 'Something else went wrong' } })
    const { status, json } = await callSignup({ name: 'Jane Doe', email: 'jane@agency.com', password: 'correct horse battery' })
    expect(status).toBe(400)
    expect(json.error).toBe('Something else went wrong')
  })
})
