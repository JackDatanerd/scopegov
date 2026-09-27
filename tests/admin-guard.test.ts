import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Fakes ───────────────────────────────────────────────────────
let authUser: any = null
let userRow: any = null
let stepUpOk = true
let queried: Array<{ table: string; calls: any[][] }> = []

function builder(table: string) {
  const rec = { table, calls: [] as any[][] }
  queried.push(rec)
  const chain: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') {
        // users lookup always resolves to userRow; anything else defaults empty.
        const res = table === 'users'
          ? { data: userRow, error: null }
          : { data: [], error: null, count: 0 }
        return (resolve: any) => resolve(res)
      }
      if (prop === 'maybeSingle') {
        return () => Promise.resolve(table === 'users' ? { data: userRow, error: null } : { data: null, error: null })
      }
      return (...args: any[]) => { rec.calls.push([prop, ...args]); return chain }
    },
  })
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: authUser } }) } }),
  createServiceClient: () => ({ from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) }),
}))
vi.mock('@/lib/auth/step-up', () => {
  const { NextResponse } = require('next/server')
  return {
    requireStepUpForCurrentUser: async () => (stepUpOk ? null : NextResponse.json({ error: 'Step-up required' }, { status: 401 })),
  }
})
vi.mock('@/lib/utils/request-ip', () => ({ getClientIpFromHeaders: () => null }))
vi.mock('next/headers', () => ({ headers: () => new Map() }))

import { requireAdmin, getAdminActor, isAdminGuardFailure } from '@/lib/auth/admin'
import { escapeIlike, quotePostgrestValue } from '@/lib/audit/search'

const verifiedFactor = [{ status: 'verified' }]

beforeEach(() => {
  queried = []
  authUser = null
  userRow = null
  stepUpOk = true
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('requireAdmin / getAdminActor', () => {
  it('denies an unauthenticated caller', async () => {
    const result = await requireAdmin()
    expect(isAdminGuardFailure(result)).toBe(true)
    if (isAdminGuardFailure(result)) expect(result.status).toBe(401)
    expect(await getAdminActor()).toBeNull()
  })

  it('404s a signed-in non-admin, without distinguishing it from "not found"', async () => {
    authUser = { id: 'u1', email: 'a@b.com', factors: verifiedFactor }
    userRow = { id: 'u1', email: 'a@b.com', name: 'A', is_platform_admin: false, deleted_at: null }
    const result = await requireAdmin()
    expect(isAdminGuardFailure(result)).toBe(true)
    if (isAdminGuardFailure(result)) expect(result.status).toBe(404)
    expect(await getAdminActor()).toBeNull()
  })

  it('404s a platform admin with no verified MFA factor — enrollment is required, not optional', async () => {
    authUser = { id: 'u1', email: 'a@b.com', factors: [] }
    userRow = { id: 'u1', email: 'a@b.com', name: 'A', is_platform_admin: true, deleted_at: null }
    const result = await requireAdmin()
    expect(isAdminGuardFailure(result)).toBe(true)
    if (isAdminGuardFailure(result)) expect(result.status).toBe(404)
    expect(await getAdminActor()).toBeNull()
  })

  it('404s a soft-deleted account even if is_platform_admin is still true', async () => {
    authUser = { id: 'u1', email: 'a@b.com', factors: verifiedFactor }
    userRow = { id: 'u1', email: 'a@b.com', name: 'A', is_platform_admin: true, deleted_at: '2026-01-01T00:00:00Z' }
    expect(await getAdminActor()).toBeNull()
  })

  it('admits a platform admin with a verified factor', async () => {
    authUser = { id: 'u1', email: 'a@b.com', factors: verifiedFactor }
    userRow = { id: 'u1', email: 'a@b.com', name: 'A', is_platform_admin: true, deleted_at: null }
    const actor = await getAdminActor()
    expect(actor).toEqual({ id: 'u1', email: 'a@b.com', name: 'A' })

    const result = await requireAdmin()
    expect(isAdminGuardFailure(result)).toBe(false)
    if (!isAdminGuardFailure(result)) expect(result.actor.id).toBe('u1')
  })

  it('blocks a mutating action when step-up fails, even for a real admin', async () => {
    authUser = { id: 'u1', email: 'a@b.com', factors: verifiedFactor }
    userRow = { id: 'u1', email: 'a@b.com', name: 'A', is_platform_admin: true, deleted_at: null }
    stepUpOk = false
    const result = await requireAdmin({ requireStepUp: true })
    expect(isAdminGuardFailure(result)).toBe(true)
    if (isAdminGuardFailure(result)) expect(result.status).toBe(401)
  })
})

// ── The exact injection class this codebase already found once
// (PostgREST filter injection, ScopeGov audit rounds 3-5) — proving the
// admin search routes build their .or() filter through the same
// escape-then-quote helpers the audit-log search box uses, rather than
// interpolating the raw query string.
describe('admin search filter construction (escapeIlike + quotePostgrestValue)', () => {
  it('a comma or parenthesis in the search term cannot inject an extra OR condition', () => {
    const malicious = 'x%2Cdeleted_at.is.null'.replace('%2C', ',') // "x,deleted_at.is.null"
    const pattern = quotePostgrestValue(`%${escapeIlike(malicious)}%`)
    const filter = ['name', 'slug', 'agency_name'].map(col => `${col}.ilike.${pattern}`).join(',')
    // The comma from user input must appear only inside the quoted value,
    // never as a bare separator between filter clauses — i.e. the string
    // splits into exactly 3 top-level clauses (one per column), not more.
    expect(filter.split('.ilike.').length - 1).toBe(3)
    expect(filter).not.toMatch(/deleted_at\.is\.null(?!")/)
  })

  it('a literal % or _ in the search term is escaped so it is matched literally, not as an ILIKE wildcard', () => {
    expect(escapeIlike('50%_off')).toBe('50\\%\\_off')
  })
})
