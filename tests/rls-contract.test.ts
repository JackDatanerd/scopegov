import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Static "contract" checks between the migrations and the code that talks to
// Postgres. Not a substitute for replaying the migrations against a real
// Postgres and switching roles (do that too) — but these are the checks that
// would have caught two shipped defects:
//
//  1. Migration 041 revoked ALL on workspace_members from `authenticated` on the
//     stated basis that "no session-bound code path reads it" — but
//     middleware.ts did, so with 041 applied every onboarded user was bounced
//     into an endless /dashboard <-> /onboarding redirect and the forced-MFA
//     check failed open. (The grep behind that claim missed `(supabase as any)`
//     followed by a line break and `.from(`.)
//  2. Any SECURITY DEFINER function left executable by anon/authenticated is
//     callable straight through /rest/v1/rpc/<name> with the public anon key.

// vitest runs from the repo root (vitest.config.ts include: tests/**).
const ROOT = process.cwd()

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

const sourceFiles = [
  ...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'components')),
  path.join(ROOT, 'middleware.ts'),
]

// Receivers that are the SESSION-bound (anon key + user JWT) client, as opposed
// to `service` / `serviceClient` (service role, bypasses RLS).
const SESSION_RECEIVER = /\b(supabase|sb)\b(?:\s+as\s+any\))?\)?\s*\.(from|rpc)\(\s*['"](\w+)['"]/g

function sessionBoundCalls(): Array<{ file: string; kind: string; name: string }> {
  const hits: Array<{ file: string; kind: string; name: string }> = []
  for (const f of sourceFiles) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of Array.from(src.matchAll(SESSION_RECEIVER))) {
      hits.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), kind: m[2], name: m[3] })
    }
  }
  return hits
}

// ── migration statement scanner ─────────────────────────────────────────────
function stripCommentsAndSplit(sql: string): string[] {
  const stmts: string[] = []
  let cur = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    if (sql.startsWith('--', i)) { const j = sql.indexOf('\n', i); i = j < 0 ? n : j; continue }
    if (sql.startsWith('/*', i)) { const j = sql.indexOf('*/', i); i = j < 0 ? n : j + 2; continue }
    if (sql[i] === "'") {
      let j = i + 1
      while (j < n) { if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue } if (sql[j] === "'") break; j++ }
      cur += sql.slice(i, j + 1); i = j + 1; continue
    }
    const dm = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i, i + 40))
    if (dm) {
      const tag = dm[0]
      const j = sql.indexOf(tag, i + tag.length)
      const end = j < 0 ? n : j + tag.length
      cur += sql.slice(i, end); i = end; continue
    }
    if (sql[i] === ';') { if (cur.trim()) stmts.push(cur.trim()); cur = ''; i++; continue }
    cur += sql[i]; i++
  }
  if (cur.trim()) stmts.push(cur.trim())
  return stmts.map(s => s.replace(/\s+/g, ' '))
}

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations')
const migrationStatements = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
  .flatMap(f => stripCommentsAndSplit(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).map(s => ({ file: f, s })))

interface FnExposure { publicGrant: boolean; anonGrant: boolean; authGrant: boolean; trigger: boolean; secdef: boolean }

function functionExposure(): Map<string, FnExposure> {
  const fns = new Map<string, FnExposure>()
  for (const { s } of migrationStatements) {
    let m = /^CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)\s*\(/i.exec(s)
    if (m) {
      const name = m[1].toLowerCase()
      const prev = fns.get(name)
      fns.set(name, {
        // Postgres grants EXECUTE to PUBLIC on creation, and Supabase's default
        // privileges also grant it directly to anon + authenticated. CREATE OR
        // REPLACE keeps existing grants.
        publicGrant: prev ? prev.publicGrant : true,
        anonGrant: prev ? prev.anonGrant : true,
        authGrant: prev ? prev.authGrant : true,
        trigger: /RETURNS\s+TRIGGER/i.test(s),
        secdef: /SECURITY DEFINER/i.test(s),
      })
      continue
    }
    m = /^REVOKE (?:ALL|EXECUTE)(?: PRIVILEGES)? ON FUNCTION (?:public\.)?(\w+)\s*\([^)]*\) FROM (.+)$/i.exec(s)
    if (m) {
      const f = fns.get(m[1].toLowerCase()); if (!f) continue
      const roles = m[2].toLowerCase()
      if (/\bpublic\b/.test(roles)) f.publicGrant = false
      if (/\banon\b/.test(roles)) f.anonGrant = false
      if (/\bauthenticated\b/.test(roles)) f.authGrant = false
      continue
    }
    m = /^GRANT EXECUTE ON FUNCTION (?:public\.)?(\w+)\s*\([^)]*\) TO (.+)$/i.exec(s)
    if (m) {
      const f = fns.get(m[1].toLowerCase()); if (!f) continue
      const roles = m[2].toLowerCase()
      if (/\bpublic\b/.test(roles)) f.publicGrant = true
      if (/\banon\b/.test(roles)) f.anonGrant = true
      if (/\bauthenticated\b/.test(roles)) f.authGrant = true
    }
  }
  return fns
}

describe('RLS contract — session-bound database access', () => {
  it('finds the scanner working (sanity: middleware makes an RPC call through the session client)', () => {
    const calls = sessionBoundCalls()
    expect(calls.some(c => c.file === 'middleware.ts' && c.kind === 'rpc' && c.name === 'middleware_gate_state')).toBe(true)
  })

  it('no code reads or writes a TABLE through the session-bound client (RLS grants are deny-by-default)', () => {
    // Every table read/write in this app goes through the service-role client;
    // the authenticated role deliberately holds almost no table privileges
    // (migrations 019/033/040/041/050/064). A session-bound .from() would fail
    // with "permission denied" — silently, when the caller ignores `error`.
    const tableCalls = sessionBoundCalls().filter(c => c.kind === 'from')
    expect(tableCalls).toEqual([])
  })

  it('every RPC called through the session-bound client is EXECUTE-granted to `authenticated`', () => {
    const exposure = functionExposure()
    const rpcNames = Array.from(new Set(sessionBoundCalls().filter(c => c.kind === 'rpc').map(c => c.name.toLowerCase())))
    for (const name of rpcNames) {
      const f = exposure.get(name)
      expect(f).toBeDefined()
      expect(f!.publicGrant || f!.authGrant).toBe(true)
    }
  })
})

describe('RLS contract — RPC surface reachable with the public anon key', () => {
  it('only the reviewed functions are executable by anon/authenticated', () => {
    const exposure = functionExposure()
    const exposed = Array.from(exposure.entries())
      .filter(([, f]) => !f.trigger && (f.publicGrant || f.anonGrant || f.authGrant))
      .map(([name]) => name)
      .sort()
    // is_active_workspace_member: caller-bound (compares against auth.uid()), used by the workspaces RLS policy.
    // middleware_gate_state:      caller-bound (auth.uid()), used by middleware.ts.
    expect(exposed).toEqual(['is_active_workspace_member', 'middleware_gate_state'])
  })

  it('no SECURITY DEFINER function without a pinned search_path is exposed to anon/authenticated', () => {
    const exposure = functionExposure()
    const bad: string[] = []
    for (const { s } of migrationStatements) {
      const m = /^CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)\s*\(/i.exec(s)
      if (!m || !/SECURITY DEFINER/i.test(s) || /SET search_path/i.test(s)) continue
      const f = exposure.get(m[1].toLowerCase())
      if (f && !f.trigger && (f.publicGrant || f.anonGrant || f.authGrant)) bad.push(m[1])
    }
    expect(bad).toEqual([])
  })
})

describe('RLS contract — migration 064 invariants', () => {
  const sql064 = fs.readFileSync(path.join(MIGRATIONS_DIR, '064_auth_rls_independent_pass_fixes.sql'), 'utf8')

  it('permission triggers and atomic functions pin search_path and use a strict boolean test', () => {
    for (const fn of ['compute_effective_permissions', 'propagate_role_permissions', 'update_role_permissions_atomic', 'update_member_permissions_atomic']) {
      const stmt = migrationStatements.filter(x => x.file.startsWith('064') && new RegExp(`FUNCTION (public\\.)?${fn}\\s*\\(`, 'i').test(x.s))
      expect(stmt.length).toBeGreaterThan(0)
      expect(/SET search_path = public, pg_temp/i.test(stmt[0].s)).toBe(true)
    }
    // the old lenient text->boolean cast must be gone from the final functions
    expect(sql064).not.toMatch(/->> protected\.perm/)
  })

  it('locks permission maps to booleans with CHECK constraints', () => {
    for (const c of ['roles_permissions_boolean_map', 'workspace_members_overrides_boolean_map', 'workspace_members_effective_boolean_map']) {
      expect(sql064).toContain(c)
    }
  })

  it('grants the gate RPC to authenticated only (never anon)', () => {
    expect(sql064).toMatch(/REVOKE ALL ON FUNCTION public\.middleware_gate_state\(text\[\]\) FROM PUBLIC, anon/)
    expect(sql064).toMatch(/GRANT EXECUTE ON FUNCTION public\.middleware_gate_state\(text\[\]\) TO authenticated/)
  })
})
