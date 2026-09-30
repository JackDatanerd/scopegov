import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Regression coverage for Onboarding independent pass 5.
//
//   B1  onboarding-status never read `error` on its queries. A failed membership lookup left the
//       result null, every branch saw "no workspaces" and the route answered 'create' — the same
//       answer a brand-new signup gets — for someone who already owns a workspace.
//   B2  the page fell through to the blank 'create' wizard when the status fetch failed and no local
//       progress existed. It now lands on a retry state.
//   B3  the mount effect had no rejection handler (gate stuck on 'loading') and treated an auth-service
//       outage as "signed out".
//   B4  submitIdentity used a bare `await res.json()`, so an HTML 502 showed "Unexpected token '<'".

let activeRows: any[]
let deactivatedRows: any[]
let defaultsRows: any[]
let usersError: any
let membersError: any
let deactivatedError: any
let defaultsError: any

function builder(table: string) {
  let statusFilter: string | null = null
  const b: any = {
    select: () => b, order: () => b, not: () => b, is: () => b, limit: () => b,
    eq: (c: string, v: any) => { if (c === 'status') statusFilter = v; return b },
    maybeSingle: () => Promise.resolve(
      table === 'users'
        ? { data: usersError ? null : { active_workspace_id: 'w1' }, error: usersError }
        : { data: null, error: null }),
    then: (resolve: any, reject: any) => {
      let result: any = { data: [], error: null }
      if (table === 'workspace_members') {
        result = statusFilter === 'deactivated'
          ? { data: deactivatedError ? null : deactivatedRows, error: deactivatedError }
          : { data: membersError ? null : activeRows, error: membersError }
      } else if (table === 'workspace_defaults') {
        result = { data: defaultsError ? null : defaultsRows, error: defaultsError }
      }
      return Promise.resolve(result).then(resolve, reject)
    },
  }
  return b
}

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
  createServiceClient: () => ({ from: (t: string) => builder(t) }),
}))

import { GET } from '@/app/api/workspace/onboarding-status/route'

const ownedIncomplete = () => ({
  workspace_id: 'w1',
  workspaces: {
    id: 'w1', created_by: 'u1', onboarding_completed_at: null, name: 'acme', agency_name: 'Acme',
    industry: 'Other', currency: 'KES', timezone: 'Africa/Nairobi', brand_colour: '#123456',
    logo_storage_path: null, governing_law: 'Kenya', sow_language: 'en', deleted_at: null,
    creator: { name: 'Me', email: 'me@x.io' },
  },
})

beforeEach(() => {
  activeRows = []; deactivatedRows = []; defaultsRows = []
  usersError = null; membersError = null; deactivatedError = null; defaultsError = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('B1 — onboarding-status fails closed on a lookup error', () => {
  it("answers 500 — never 'create' — when the membership lookup errors", async () => {
    membersError = { message: 'connection reset' }
    const res = await GET()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.status).toBeUndefined()
    expect(body.error).toBeTruthy()
  })

  it('answers 500 when the users lookup errors', async () => {
    usersError = { message: 'timeout' }
    activeRows = [ownedIncomplete()]
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).status).toBeUndefined()
  })

  it("answers 500 — not 'create' — when the suspended-workspace lookup errors", async () => {
    deactivatedError = { message: 'timeout' }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).status).toBeUndefined()
  })

  it('does not leak the raw database message to the client', async () => {
    membersError = { message: 'relation "workspace_members" does not exist' }
    const body = await (await GET()).json()
    expect(JSON.stringify(body)).not.toMatch(/workspace_members|relation/)
  })

  it('answers 500 when the saved-defaults read fails on resume, instead of rehydrating step defaults', async () => {
    activeRows = [ownedIncomplete()]
    defaultsError = { message: 'timeout' }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).revisionRounds).toBeUndefined()
  })

  it('still resumes with the real saved defaults when nothing errors', async () => {
    activeRows = [ownedIncomplete()]
    defaultsRows = [{ revision_rounds: 4, payment_structure: 'milestones' }]
    const body = await (await GET()).json()
    expect(body).toMatchObject({
      status: 'resume', workspaceId: 'w1', revisionRounds: '4', paymentStructure: 'milestones', governingLaw: 'Kenya',
    })
  })

  it("still answers 'create' for a genuinely new user (no rows, no errors)", async () => {
    expect(await (await GET()).json()).toEqual({ status: 'create' })
  })
})

const page = readFileSync(join(process.cwd(), 'app/onboarding/page.tsx'), 'utf8')

describe('B2 — a failed status check with no saved progress shows a retry state, not the blank wizard', () => {
  it("adds 'status_error' to the gate states", () => {
    expect(page).toMatch(/'suspended' \| 'status_error'>\('loading'\)/)
  })

  it('sets status_error inside the statusFetchFailed branch, after the local-progress restore and before the fresh-start path', () => {
    const start = page.indexOf('if (statusFetchFailed) {')
    const restoreReturn = page.indexOf("setGate('create')\n              return", start)
    const errorGate = page.indexOf("setGate('status_error')", start)
    const freshStart = page.indexOf("localStorage.removeItem(STORAGE_KEY_PREFIX + user.id) } catch { /* ignore */ }\n      const userName", start)
    expect(start).toBeGreaterThan(0)
    expect(restoreReturn).toBeGreaterThan(start)
    expect(errorGate).toBeGreaterThan(restoreReturn)
    expect(freshStart).toBeGreaterThan(errorGate)
  })

  it('renders the retry state with a reload button and a sign-out, and writes nothing', () => {
    const block = page.slice(page.indexOf("if (gate === 'status_error')"), page.indexOf("if (gate === 'switch_error')"))
    expect(block).toMatch(/window\.location\.reload\(\)/)
    expect(block).toMatch(/signOut\(\{ scope: 'local' \}\)/)
    expect(block).not.toMatch(/fetch\(/)
  })
})

describe('B3 — the mount effect cannot strand the page or misread an auth outage', () => {
  it('reads getUser()\'s error and separates an outage from a missing session', () => {
    expect(page).toMatch(/import \{ isAuthRetryableFetchError \} from '@supabase\/supabase-js'/)
    expect(page).toMatch(/\{ data: \{ user \}, error: authError \}/)
    expect(page).toMatch(/authError && \(isAuthRetryableFetchError\(authError\)/)
  })

  it("still sends a genuinely signed-out visitor to /login", () => {
    const start = page.indexOf('error: authError')
    const slice = page.slice(start, page.indexOf('userIdRef.current = user.id', start))
    expect(slice).toMatch(/router\.push\('\/login'\)/)
  })

  it("has a rejection handler that only claims a still-'loading' gate", () => {
    expect(page).toMatch(/\}\)\.catch\(\(\) => \{[\s\S]*?setGate\(g => \(g === 'loading' \? 'status_error' : g\)\)[\s\S]*?\}\)\n  \}, \[explicitNew\]\)/)
  })
})

describe('B4 — submitIdentity survives a non-JSON error reply', () => {
  // Code only — the explanatory comment in the function names the bare call on purpose.
  const fn = page.slice(page.indexOf('async function submitIdentity'), page.indexOf('/* ── Step 1: Branding'))
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

  it('never calls a bare res.json() on the create response', () => {
    expect(fn).not.toMatch(/await res\.json\(\)(?!\.catch)/)
    expect(fn.match(/await res\.json\(\)\.catch\(/g)?.length).toBe(2)
  })

  it('refuses a 2xx reply that carries no workspaceId instead of continuing with undefined', () => {
    expect(fn).toMatch(/if \(!newId\) throw new Error\('Failed to create workspace'\)/)
  })

  it('words a network-level failure itself rather than showing the engine text', () => {
    expect(fn).toMatch(/err instanceof TypeError/)
    expect(fn).toMatch(/Could not reach the server/)
  })
})
