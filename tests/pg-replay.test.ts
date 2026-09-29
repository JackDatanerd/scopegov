// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import fs from 'fs'
import path from 'path'

const URL_ = process.env.PG_REPLAY_URL
const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations')
const SHIM = path.join(__dirname, 'pg-replay', 'supabase-shim.sql')

let admin: Pool
let pool: Pool
let dbName = ''

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const W = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function urlFor(db: string) { const u = new URL(URL_!); u.pathname = '/' + db; return u.toString() }
async function sql(text: string, params: any[] = []) { return (await pool.query(text, params)).rows }

/** Run `fn` as a Supabase API role with the given JWT subject, inside a transaction that is always rolled back. */
async function asRole<T>(role: 'anon' | 'authenticated' | 'service_role', uid: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL ROLE ${role}`)
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(uid ? { sub: uid, role } : { role })])
    return await fn(c)
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release() }
}
/**
 * Re-apply a migration to prove it is idempotent, then ROLL BACK. Re-applying an OLD migration for real
 * would re-create the function definitions it contains and silently revert every later migration that
 * replaced them (068 re-creates create_workspace_atomic and leave_workspace_atomic, for instance), so the
 * tests that run after it would be exercising stale definitions instead of the schema the app actually has.
 */
async function reapply(prefix: string, after?: (c: PoolClient) => Promise<void>) {
  const f = fs.readdirSync(MIGRATIONS).find(x => x.startsWith(prefix))!
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    if (after) await after(c)
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release() }
}

const denied = async (c: PoolClient, text: string) => {
  await c.query('SAVEPOINT s')
  try { await c.query(text); await c.query('RELEASE SAVEPOINT s'); return false }
  catch (e: any) { await c.query('ROLLBACK TO SAVEPOINT s'); return /permission denied|row-level security/i.test(e.message) }
}

async function makeUser(n: number, email = `u${n}@test.dev`) {
  await sql(`INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES ($1::uuid, $2, $3::jsonb, now()) ON CONFLICT DO NOTHING`, [U(n), email, JSON.stringify({ name: `User ${n}` })])
  await sql(`INSERT INTO auth.identities (provider_id, user_id, provider, identity_data, email) VALUES ($1::text, $1::uuid, 'email', '{}', $2) ON CONFLICT DO NOTHING`, [U(n), email])
}
async function makeWorkspace(w: number, owner: number, plan = 'trial') {
  await sql(`SELECT public.create_workspace_atomic($1,$2,'WS','ws-${w}-${Math.random().toString(36).slice(2, 7)}','WS','Marketing','USD','UTC','secret')`, [W(w), U(owner)])
  await sql(`UPDATE public.users SET active_workspace_id = $1 WHERE id = $2`, [W(w), U(owner)])
  if (plan !== 'trial') await sql(`UPDATE public.workspaces SET plan_tier = $2 WHERE id = $1`, [W(w), plan])
}
async function addMember(w: number, user: number, roleName: string, status = 'active') {
  const [{ id }] = await sql(`SELECT id FROM public.roles WHERE workspace_id = $1 AND name = $2`, [W(w), roleName])
  const [m] = await sql(`INSERT INTO public.workspace_members (workspace_id, user_id, role_id, status, invited_email) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [W(w), U(user), id, status, `u${user}@test.dev`])
  return m.id as string
}

describe.skipIf(!URL_)('Postgres replay (migrations 001..latest on a real database)', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: URL_, max: 1 })
    admin.on('error', () => {})
    dbName = `sg_replay_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    await admin.query(`CREATE DATABASE ${dbName}`)
    pool = new Pool({ connectionString: urlFor(dbName), max: 40 })
    await pool.query(`ALTER DATABASE ${dbName} SET search_path = "$user", public, extensions`)
    await pool.end()
    pool = new Pool({ connectionString: urlFor(dbName), max: 40 })
    pool.on('error', () => { /* connections are terminated when the database is dropped */ })
    await pool.query(fs.readFileSync(SHIM, 'utf8'))
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
      try { await pool.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')) }
      catch (e: any) { throw new Error(`Migration ${f} failed on replay: ${e.message}`) }
    }
  }, 240_000)

  afterAll(async () => {
    await pool?.end().catch(() => {})
    await new Promise(r => setTimeout(r, 200))
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {}); await admin.end() }
  })

  // ── grants / exposure ────────────────────────────────────────────────────
  describe('what the public anon key can reach', () => {
    it('anon holds no privilege on any public table or sequence', async () => {
      const rows = await sql(`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
          AND ( has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
             OR (c.relkind <> 'S' AND has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')) )`)
      expect(rows.map(r => r.relname)).toEqual([])
    })

    it('authenticated reaches only users, workspaces and user_mfa_backup_codes — read only', async () => {
      const rows = await sql(`
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
          AND c.relname NOT IN ('users','workspaces','user_mfa_backup_codes')
          AND ( has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
             OR has_any_column_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') )`)
      expect(rows.map(r => r.relname)).toEqual([])
      for (const t of ['users', 'workspaces', 'user_mfa_backup_codes']) {
        const [r] = await sql(`SELECT has_any_column_privilege('authenticated', $1::regclass, 'INSERT,UPDATE') w, has_table_privilege('authenticated', $1::regclass, 'DELETE,TRUNCATE') d`, [`public.${t}`])
        expect({ t, w: r.w, d: r.d }).toEqual({ t, w: false, d: false })
      }
    })

    it('the only non-trigger public functions the API roles can execute are the reviewed ones', async () => {
      const rows = await sql(`
        SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prorettype <> 'trigger'::regtype
          AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`)
      expect(rows.map(r => r.proname).sort()).toEqual(['immutable_unaccent', 'is_active_workspace_member', 'is_current_user_platform_admin', 'middleware_gate_state'])
    })

    it('every function added by migration 068 (and its hooks) is closed to the API roles', async () => {
      const names = ['auth_attempt_begin', 'auth_attempt_release', 'hook_mfa_verification_attempt', 'hook_password_verification_attempt',
        'issue_backup_codes', 'list_user_sessions', 'revoke_user_session', 'revoke_user_sessions', 'user_has_password',
        'security_audit_insert', 'audit_active_workspace', 'leave_workspace_atomic', 'create_workspace_atomic']
      for (const n of names) {
        const [r] = await sql(`SELECT bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) a, bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) u
                               FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' AND p.proname = $1`, [n])
        expect({ n, a: r.a, u: r.u }).toEqual({ n, a: false, u: false })
      }
    })

    it('the cron_heartbeats grant drift is closed', async () => {
      const [r] = await sql(`SELECT has_table_privilege('anon','public.cron_heartbeats','SELECT,INSERT,UPDATE,DELETE') a, has_table_privilege('authenticated','public.cron_heartbeats','SELECT,INSERT,UPDATE,DELETE') u`)
      expect(r).toEqual({ a: false, u: false })
    })

    it('a NEW table created later gets no API-role grants by default', async () => {
      await sql(`CREATE TABLE public.zz_probe (id int)`)
      const [r] = await sql(`SELECT has_table_privilege('anon','public.zz_probe','SELECT') a, has_table_privilege('authenticated','public.zz_probe','SELECT') u`)
      await sql(`DROP TABLE public.zz_probe`)
      expect(r).toEqual({ a: false, u: false })
    })
  })

  describe('attacking as an authenticated user', () => {
    beforeAll(async () => { await makeUser(1); await makeUser(2); await makeWorkspace(1, 1); await makeWorkspace(2, 2) })

    it('can read only their own users row', async () => {
      const rows = await asRole('authenticated', U(1), c => c.query('SELECT id FROM public.users').then(r => r.rows))
      expect(rows.map((r: any) => r.id)).toEqual([U(1)])
    })

    it('cannot rewrite public.users.name (the direct path that used to skip every sanitiser)', async () => {
      await asRole('authenticated', U(1), async c => {
        expect(await denied(c, `UPDATE public.users SET name = repeat('A', 5000) WHERE id = '${U(1)}'`)).toBe(true)
        expect(await denied(c, `UPDATE public.users SET active_workspace_id = '${W(2)}' WHERE id = '${U(1)}'`)).toBe(true)
      })
    })

    it('cannot read membership, billing or secrets tables, or another workspace', async () => {
      await asRole('authenticated', U(1), async c => {
        for (const t of ['workspace_members', 'workspace_secrets', 'billing', 'audit_log', 'roles', 'invoices']) {
          expect(await denied(c, `SELECT * FROM public.${t}`), t).toBe(true)
        }
        const r = await c.query('SELECT id FROM public.workspaces')
        expect(r.rows.map((x: any) => x.id)).toEqual([W(1)])
        const cols = await c.query(`SELECT column_name FROM information_schema.role_column_grants WHERE grantee = 'authenticated' AND table_schema = 'public' AND table_name = 'workspaces'`)
        expect(cols.rows.map((r: any) => r.column_name).filter((n: string) => /secret|token|password|paystack|key/i.test(n))).toEqual([])
      })
    })

    it('cannot see the backup-code hashes even of their own codes', async () => {
      await asRole('authenticated', U(1), async c => { expect(await denied(c, 'SELECT code_hash FROM public.user_mfa_backup_codes')).toBe(true) })
    })

    it('cannot call the ledger, hooks, session or backup-code functions', async () => {
      await asRole('authenticated', U(1), async c => {
        expect(await denied(c, `SELECT public.auth_attempt_begin('${U(1)}','mfa_verify',5,300)`)).toBe(true)
        expect(await denied(c, `SELECT public.list_user_sessions('${U(2)}')`)).toBe(true)
        expect(await denied(c, `SELECT public.revoke_user_sessions('${U(2)}')`)).toBe(true)
        expect(await denied(c, `SELECT public.issue_backup_codes('${U(2)}', ARRAY['x'])`)).toBe(true)
      })
    })

    it('anon cannot even ask whether someone is a member', async () => {
      const r = await asRole('anon', null, c => c.query(`SELECT public.is_active_workspace_member('${W(2)}','${U(2)}') AS v`).then(x => x.rows[0].v).catch(() => 'denied'))
      expect([false, 'denied']).toContain(r)
    })
  })

  // ── atomic ledger + hooks ────────────────────────────────────────────────
  describe('attempt ledger', () => {
    beforeAll(async () => { await makeUser(10) })

    it('lets exactly 5 of 40 PARALLEL attempts through (the old check-then-act limiter let all 40)', async () => {
      const results = await Promise.all(Array.from({ length: 40 }, () =>
        pool.query(`SELECT public.auth_attempt_begin($1,'mfa_verify',5,300) AS r`, [U(10)]).then(r => r.rows[0].r)))
      expect(results.filter((r: any) => r.allowed).length).toBe(5)
      const [{ n }] = await sql(`SELECT count(*)::int n FROM public.auth_attempts WHERE user_id = $1 AND kind = 'mfa_verify'`, [U(10)])
      expect(n).toBe(5)
      expect(results.find((r: any) => !r.allowed).retry_after_seconds).toBeGreaterThan(0)
    })

    it('a released reservation frees its slot; clearing wipes the history', async () => {
      await makeUser(11)
      const first = (await sql(`SELECT public.auth_attempt_begin($1,'mfa_recover',2,300) AS r`, [U(11)]))[0].r
      await sql(`SELECT public.auth_attempt_begin($1,'mfa_recover',2,300)`, [U(11)])
      expect((await sql(`SELECT public.auth_attempt_begin($1,'mfa_recover',2,300) AS r`, [U(11)]))[0].r.allowed).toBe(false)
      await sql(`SELECT public.auth_attempt_release($1)`, [first.attempt_id])
      expect((await sql(`SELECT public.auth_attempt_begin($1,'mfa_recover',2,300) AS r`, [U(11)]))[0].r.allowed).toBe(true)
    })

    it('the MFA hook locks direct GoTrue guesses after 5 failures, even for a CORRECT code', async () => {
      await makeUser(12); await makeWorkspace(12, 12)
      const ev = (valid: boolean) => JSON.stringify({ user_id: U(12), factor_id: U(99), factor_type: 'totp', valid })
      for (let i = 0; i < 5; i++) {
        const r = (await sql(`SELECT public.hook_mfa_verification_attempt($1::jsonb) AS r`, [ev(false)]))[0].r
        expect(r.decision).toBe('continue')
      }
      const locked = (await sql(`SELECT public.hook_mfa_verification_attempt($1::jsonb) AS r`, [ev(true)]))[0].r
      expect(locked.decision).toBe('reject')
      expect(locked.message).toMatch(/too many incorrect attempts/i)
      const audit = await sql(`SELECT event_type FROM public.audit_log WHERE actor_id = $1 AND event_type = 'security.mfa_locked'`, [U(12)])
      expect(audit).toHaveLength(1)
    })

    it('a valid code below the threshold clears the hook ledger', async () => {
      await makeUser(13)
      const ev = (valid: boolean) => JSON.stringify({ user_id: U(13), valid })
      await sql(`SELECT public.hook_mfa_verification_attempt($1::jsonb)`, [ev(false)])
      await sql(`SELECT public.hook_mfa_verification_attempt($1::jsonb)`, [ev(true)])
      const [{ n }] = await sql(`SELECT count(*)::int n FROM public.auth_attempts WHERE user_id = $1`, [U(13)])
      expect(n).toBe(0)
    })

    it('the password hook audits failures and locks after 10', async () => {
      await makeUser(14); await makeWorkspace(14, 14)
      const ev = JSON.stringify({ user_id: U(14), valid: false })
      for (let i = 0; i < 10; i++) await sql(`SELECT public.hook_password_verification_attempt($1::jsonb)`, [ev])
      expect((await sql(`SELECT public.hook_password_verification_attempt($1::jsonb) AS r`, [ev]))[0].r.decision).toBe('reject')
      const [{ n }] = await sql(`SELECT count(*)::int n FROM public.audit_log WHERE actor_id = $1 AND event_type = 'security.login_failed'`, [U(14)])
      expect(n).toBe(10)
    })
  })

  // ── sign-in audit trigger ────────────────────────────────────────────────
  describe('server-side sign-in audit', () => {
    it('records a password sign-in with the IP, without any client cooperation', async () => {
      await makeUser(20); await makeWorkspace(20, 20)
      await sql(`INSERT INTO auth.sessions (user_id, ip, user_agent, aal) VALUES ($1,'203.0.113.9','UA/1','aal1')`, [U(20)])
      const rows = await sql(`SELECT metadata, ip_address FROM public.audit_log WHERE actor_id = $1 AND event_type = 'security.login_succeeded'`, [U(20)])
      expect(rows).toHaveLength(1)
      expect(rows[0].ip_address).toBe('203.0.113.9')
      expect(rows[0].metadata.source).toBe('db_trigger')
      expect(rows[0].metadata.method).toBe('password')
    })

    it('an MFA account is only logged once its session reaches aal2', async () => {
      await makeUser(21); await makeWorkspace(21, 21)
      await sql(`INSERT INTO auth.mfa_factors (user_id, factor_type, status) VALUES ($1,'totp','verified')`, [U(21)])
      const [s] = await sql(`INSERT INTO auth.sessions (user_id, ip, aal) VALUES ($1,'203.0.113.10','aal1') RETURNING id`, [U(21)])
      const count = async () => (await sql(`SELECT count(*)::int n FROM public.audit_log WHERE actor_id = $1 AND event_type = 'security.login_succeeded'`, [U(21)]))[0].n
      expect(await count()).toBe(0)
      await sql(`UPDATE auth.sessions SET aal = 'aal2' WHERE id = $1`, [s.id])
      expect(await count()).toBe(1)
      await sql(`UPDATE auth.sessions SET aal = 'aal2', refreshed_at = now() WHERE id = $1`, [s.id])   // a refresh is not a sign-in
      expect(await count()).toBe(1)
    })
  })

  // ── sessions / helpers ───────────────────────────────────────────────────
  describe('session management + helpers', () => {
    it('lists only the caller\u2019s sessions and revokes one, or all but the current', async () => {
      await makeUser(30); await makeUser(31)
      const [a] = await sql(`INSERT INTO auth.sessions (user_id, aal) VALUES ($1,'aal1') RETURNING id`, [U(30)])
      const [b] = await sql(`INSERT INTO auth.sessions (user_id, aal) VALUES ($1,'aal1') RETURNING id`, [U(30)])
      await sql(`INSERT INTO auth.sessions (user_id, aal) VALUES ($1,'aal1')`, [U(31)])
      expect((await sql(`SELECT * FROM public.list_user_sessions($1)`, [U(30)])).length).toBe(2)
      expect((await sql(`SELECT public.revoke_user_session($1,$2) AS r`, [U(31), a.id]))[0].r).toBe(false)   // not theirs
      expect((await sql(`SELECT public.revoke_user_session($1,$2) AS r`, [U(30), a.id]))[0].r).toBe(true)
      expect((await sql(`SELECT public.revoke_user_sessions($1,$2) AS n`, [U(30), b.id]))[0].n).toBe(0)
      expect((await sql(`SELECT public.revoke_user_sessions($1, NULL) AS n`, [U(30)]))[0].n).toBe(1)
    })

    it('user_has_password reads the real credential, not the identity list', async () => {
      await makeUser(32)
      await sql(`UPDATE auth.users SET encrypted_password = '' WHERE id = $1`, [U(32)])
      expect((await sql(`SELECT public.user_has_password($1) v`, [U(32)]))[0].v).toBe(false)
      await sql(`UPDATE auth.users SET encrypted_password = 'x' WHERE id = $1`, [U(32)])
      expect((await sql(`SELECT public.user_has_password($1) v`, [U(32)]))[0].v).toBe(true)
    })

    it('issue_backup_codes retires the previous set and inserts the new one atomically (also under a race)', async () => {
      await makeUser(33)
      await sql(`SELECT public.issue_backup_codes($1, ARRAY['a1','a2','a3'])`, [U(33)])
      await Promise.all([
        sql(`SELECT public.issue_backup_codes($1, ARRAY['b1','b2'])`, [U(33)]),
        sql(`SELECT public.issue_backup_codes($1, ARRAY['c1','c2'])`, [U(33)]),
      ])
      const [{ n }] = await sql(`SELECT count(*)::int n FROM public.user_mfa_backup_codes WHERE user_id = $1 AND used_at IS NULL`, [U(33)])
      expect(n).toBe(2)   // exactly ONE set is ever live (the old code left both b* and c* valid)
    })
  })

  // ── middleware_gate_state fallback ─────────────────────────────────────────
  describe('middleware_gate_state onboarding fallback', () => {
    it('prefers a completed workspace over an older, never-onboarded one when active_workspace_id is stale', async () => {
      // Carol owns an older workspace that never finished onboarding, and is
      // also an active member of a newer workspace (Dave's) that has. Her
      // active_workspace_id is stale/unset, so middleware_gate_state has to
      // fall back — and must pick the completed one, exactly like
      // pickFallbackMembership()/getSession() would, not just the oldest.
      await makeUser(80); await makeWorkspace(80, 80)   // Carol's own, never onboarded
      await sql(`UPDATE public.workspaces SET created_at = now() - interval '30 days' WHERE id = $1`, [W(80)])
      await sql(`UPDATE public.workspace_members SET created_at = now() - interval '30 days' WHERE workspace_id = $1 AND user_id = $2`, [W(80), U(80)])

      await makeUser(81); await makeWorkspace(81, 81)   // Dave's, completed
      await sql(`UPDATE public.workspaces SET onboarding_completed_at = now() WHERE id = $1`, [W(81)])
      await addMember(81, 80, 'Owner', 'active')         // Carol also joins Dave's

      await sql(`UPDATE public.users SET active_workspace_id = NULL WHERE id = $1`, [U(80)])

      const [gate] = await asRole('authenticated', U(80), c =>
        c.query(`SELECT public.middleware_gate_state(ARRAY[]::text[]) g`).then(r => r.rows))
      expect(gate.g.has_workspace).toBe(true)
      expect(gate.g.onboarding_complete).toBe(true)   // was false before this fix — picked the older, incomplete workspace
    })
  })

  // ── users.name ───────────────────────────────────────────────────────────
  describe('users.name constraint', () => {
    it('rejects newlines and over-long names at the database', async () => {
      await makeUser(40)
      await expect(sql(`UPDATE public.users SET name = E'evil\\nname' WHERE id = $1`, [U(40)])).rejects.toThrow(/users_name_clean/)
      await expect(sql(`UPDATE public.users SET name = repeat('A', 121) WHERE id = $1`, [U(40)])).rejects.toThrow(/users_name_clean/)
      await sql(`UPDATE public.users SET name = repeat('A', 120) WHERE id = $1`, [U(40)])
    })
  })

  // ── workspace + role invariants ──────────────────────────────────────────
  describe('roles and permissions', () => {
    it('the seeded Owner role holds exactly the 24 real permissions (no stale EXPORT_DATA key)', async () => {
      await makeUser(50); await makeWorkspace(50, 50)
      const [r] = await sql(`SELECT permissions FROM public.roles WHERE workspace_id = $1 AND name = 'Owner'`, [W(50)])
      expect(Object.keys(r.permissions)).toHaveLength(24)
      expect(r.permissions).not.toHaveProperty('EXPORT_DATA')
      expect((await sql(`SELECT count(*)::int n FROM public.roles WHERE permissions ? 'EXPORT_DATA'`))[0].n).toBe(0)
    })

    it('rejects non-boolean permission maps and duplicate role names', async () => {
      await expect(sql(`INSERT INTO public.roles (workspace_id, name, permissions, created_by) VALUES ($1,'bad','{"DELETE_PROJECTS":1}',$2)`, [W(50), U(50)])).rejects.toThrow()
      await sql(`INSERT INTO public.roles (workspace_id, name, permissions, created_by) VALUES ($1,'Dup','{}',$2)`, [W(50), U(50)])
      await expect(sql(`INSERT INTO public.roles (workspace_id, name, permissions, created_by) VALUES ($1,'dup','{}',$2)`, [W(50), U(50)])).rejects.toThrow(/unique/i)
    })

    it('the orphan guard holds under a concurrent race (two admins stripping each other)', async () => {
      await makeUser(51); await makeUser(52); await makeWorkspace(51, 51)
      const ma = (await sql(`SELECT id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [W(51), U(51)]))[0].id
      const mb = await addMember(51, 52, 'Owner')
      const strip = (id: string) => pool.query(`SELECT public.update_member_permissions_atomic($1,$2,false,NULL,true,'{"MANAGE_ROLES":false,"MANAGE_WORKSPACE_SETTINGS":false}'::jsonb)`, [W(51), id])
      const outcomes = await Promise.allSettled([strip(ma), strip(mb)])
      expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1)
      expect((outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult).reason.message).toMatch(/would_orphan_permissions/)
    })
  })

  describe('leave_workspace_atomic', () => {
    async function setup(base: number) {
      await makeUser(base); await makeUser(base + 1)
      await makeWorkspace(base, base, 'agency')
      const m2 = await addMember(base, base + 1, 'Owner')
      return { creator: (await sql(`SELECT id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [W(base), U(base)]))[0].id as string, m2 }
    }
    const leave = (w: number, u: number) => sql(`SELECT public.leave_workspace_atomic($1,$2)`, [W(w), U(u)])

    it('refuses the sole MANAGE_ROLES holder (guard 065 had dropped)', async () => {
      await makeUser(60); await makeUser(61); await makeWorkspace(60, 60, 'agency')
      const [{ id: acct }] = await sql(`SELECT id FROM public.roles WHERE workspace_id = $1 AND name = 'Account Manager'`, [W(60)])
      await sql(`INSERT INTO public.workspace_members (workspace_id, user_id, role_id, status) VALUES ($1,$2,$3,'active')`, [W(60), U(61), acct])
      // user 61 is the only OTHER member; give the creator's role away so 61 leaves while 60 holds everything -> fine; now try 60 leaving
      await expect(leave(60, 60)).rejects.toThrow(/sole_admin|sole_roles_admin/)
    })

    it('refuses the creator of a TRIAL workspace (guard 065 had dropped)', async () => {
      await makeUser(62); await makeUser(63); await makeWorkspace(62, 62, 'trial')
      await addMember(62, 63, 'Owner')
      await expect(leave(62, 62)).rejects.toThrow(/trial_creator/)
    })

    it('archives the leaver\u2019s project assignments and revokes the invites they sent', async () => {
      const { creator, m2 } = await setup(64)
      const [client] = await sql(`INSERT INTO public.clients (workspace_id, name, email) VALUES ($1,'C','c@x.dev') RETURNING id`, [W(64)])
      const [proj] = await sql(`INSERT INTO public.projects (workspace_id, client_id, name, type, created_by) VALUES ($1,$2,'P','web',$3) RETURNING id`, [W(64), client.id, U(64)])
      await sql(`INSERT INTO public.project_members (project_id, member_id, added_by) VALUES ($1,$2,$3)`, [proj.id, m2, U(64)])
      await sql(`INSERT INTO public.workspace_members (workspace_id, role_id, status, invited_email, invited_by, invite_token, invite_token_expires_at)
                 SELECT $1, id, 'invited', 'pending@x.dev', $2, 'tok-64', now() + interval '7 days' FROM public.roles WHERE workspace_id = $1 AND name = 'Account Manager'`, [W(64), U(65)])
      await leave(64, 65)
      expect((await sql(`SELECT count(*)::int n FROM public.project_members WHERE member_id = $1`, [m2]))[0].n).toBe(0)
      expect((await sql(`SELECT count(*)::int n FROM public.deactivated_member_projects WHERE member_id = $1`, [m2]))[0].n).toBe(1)
      expect((await sql(`SELECT count(*)::int n FROM public.workspace_members WHERE workspace_id = $1 AND invited_email = 'pending@x.dev'`, [W(64)]))[0].n).toBe(0)
      expect(creator).toBeTruthy()
    })
  })

  describe('audit + idempotence', () => {
    it('a password change is audited in EVERY workspace the person belongs to', async () => {
      await makeUser(70); await makeUser(71); await makeWorkspace(70, 70); await makeWorkspace(71, 71)
      await addMember(71, 70, 'Account Manager')
      await sql(`UPDATE auth.users SET encrypted_password = 'h1' WHERE id = $1`, [U(70)])
      await sql(`UPDATE auth.users SET encrypted_password = 'h2' WHERE id = $1`, [U(70)])
      const rows = await sql(`SELECT DISTINCT workspace_id FROM public.audit_log WHERE actor_id = $1 AND event_type = 'security.password_changed'`, [U(70)])
      expect(rows.map(r => r.workspace_id).sort()).toEqual([W(70), W(71)].sort())
    })

    it('the audit log stays append-only', async () => {
      await makeUser(72); await makeWorkspace(72, 72)
      await sql(`INSERT INTO public.audit_log (workspace_id, actor_id, actor_email, actor_name, event_type, entity_type) VALUES ($1,$2,'a@b','n','test.event','x')`, [W(72), U(72)])
      await expect(sql(`UPDATE public.audit_log SET actor_name = 'tampered'`)).rejects.toThrow()
      await expect(sql(`DELETE FROM public.audit_log`)).rejects.toThrow()
    })

    it('migration 068 can be applied a second time without error', async () => {
      await reapply('068_')
    })

    it('the storage buckets carry size and mime limits', async () => {
      const rows = await sql(`SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id IN ('logos','flag-evidence') ORDER BY id`)
      expect(rows.map(r => r.id)).toEqual(['flag-evidence', 'logos'])
      for (const r of rows) { expect(Number(r.file_size_limit)).toBeGreaterThan(0); expect(r.allowed_mime_types.length).toBeGreaterThan(0) }
      expect(rows.find(r => r.id === 'logos')!.allowed_mime_types).toEqual(['image/png', 'image/jpeg'])
    })
  })

  // ── approval RPCs (migrations 069 / 095 / 103 / 110) ────────────────────
  // Section-11 audit (B8): nothing exercised decide_approval_step against a real database, which is how the
  // 7-argument overload shipped executable by anon/authenticated until migration 103.
  describe('approval RPCs (decide_approval_step)', () => {
    async function makeChain(opts: { steps?: number; distinct?: boolean } = {}) {
      const steps = opts.steps ?? 2
      const [wf] = await sql(`INSERT INTO public.approval_workflows (workspace_id, document_type, name, created_by, is_active) VALUES ($1,'sow','wf',$2,false) RETURNING id`, [W(190), U(190)])
      const [rq] = await sql(
        `INSERT INTO public.approval_requests (workspace_id, workflow_id, document_type, document_id, requested_by, total_steps, require_distinct_approvers)
         VALUES ($1,$2,'sow',gen_random_uuid(),$3,$4,$5) RETURNING id, step_started_at`,
        [W(190), wf.id, U(190), steps, opts.distinct ?? true])
      const stepIds: string[] = []
      for (let i = 1; i <= steps; i++) {
        const [st] = await sql(`INSERT INTO public.approval_steps (request_id, step_order, approver_user_id) VALUES ($1,$2,$3) RETURNING id`, [rq.id, i, U(190 + i)])
        stepIds.push(st.id)
      }
      return { requestId: rq.id as string, stepIds, startedAt: rq.step_started_at as Date }
    }
    const decide = (c: PoolClient, requestId: string, stepId: string, decision: string, actor: number, expectedUser: number | null) =>
      c.query(`SELECT public.decide_approval_step($1::uuid,$2::uuid,$3,$4::uuid,NULL,$5::uuid,NULL::uuid) AS r`,
        [requestId, stepId, decision, U(actor), expectedUser == null ? null : U(expectedUser)]).then(r => r.rows[0].r as string)

    beforeAll(async () => {
      await makeUser(190); await makeUser(191); await makeUser(192)
      await makeWorkspace(190, 190)
    })

    it('is not executable by anon or authenticated (the 7-argument overload)', async () => {
      const { requestId, stepIds } = await makeChain()
      const call = `SELECT public.decide_approval_step('${requestId}'::uuid,'${stepIds[0]}'::uuid,'approved','${U(191)}'::uuid,NULL,'${U(191)}'::uuid,NULL::uuid)`
      expect(await asRole('anon', null, c => denied(c, call))).toBe(true)
      expect(await asRole('authenticated', U(191), c => denied(c, call))).toBe(true)
      // …and only one overload exists (069's 5-argument version was dropped by 095).
      const fns = await sql(`SELECT pg_get_function_identity_arguments(oid) a FROM pg_proc WHERE proname = 'decide_approval_step' AND pronamespace = 'public'::regnamespace`)
      expect(fns).toHaveLength(1)
    })

    it('step_started_at is NOT NULL, defaults on insert, and advances only when the step advances', async () => {
      const { requestId, stepIds, startedAt } = await makeChain()
      expect(startedAt).toBeInstanceOf(Date)
      // A cron-style reminder bump moves updated_at but must leave step_started_at alone.
      await sql(`UPDATE public.approval_requests SET updated_at = now() + interval '1 hour' WHERE id = $1`, [requestId])
      expect((await sql(`SELECT step_started_at FROM public.approval_requests WHERE id = $1`, [requestId]))[0].step_started_at).toEqual(startedAt)
      await asRole('service_role', null, async c => {
        expect(await decide(c, requestId, stepIds[0], 'approved', 191, 191)).toBe('advanced')
        const { rows: [r] } = await c.query(`SELECT current_step, step_started_at FROM public.approval_requests WHERE id = $1`, [requestId])
        expect(r.current_step).toBe(2)
        expect(r.step_started_at.getTime()).toBeGreaterThan(startedAt.getTime())
      })
    })

    it('the last approval returns final and claims the send; a rejection skips the remaining steps', async () => {
      const a = await makeChain({ steps: 1 })
      await asRole('service_role', null, async c => {
        expect(await decide(c, a.requestId, a.stepIds[0], 'approved', 191, 191)).toBe('final')
        const { rows: [r] } = await c.query(`SELECT status, sending_started_at FROM public.approval_requests WHERE id = $1`, [a.requestId])
        expect(r.status).toBe('pending'); expect(r.sending_started_at).not.toBeNull()
      })
      const b = await makeChain({ steps: 2 })
      await asRole('service_role', null, async c => {
        expect(await decide(c, b.requestId, b.stepIds[0], 'rejected', 191, 191)).toBe('rejected')
        const { rows } = await c.query(`SELECT status FROM public.approval_steps WHERE request_id = $1 ORDER BY step_order`, [b.requestId])
        expect(rows.map((x: any) => x.status)).toEqual(['rejected', 'skipped'])
        expect((await c.query(`SELECT status FROM public.approval_requests WHERE id = $1`, [b.requestId])).rows[0].status).toBe('rejected')
      })
    })

    it("returns 'reassigned' when the step was reassigned away from the actor mid-flight", async () => {
      const { requestId, stepIds } = await makeChain()
      await asRole('service_role', null, async c => {
        // actor 191 validated against user 191, then the step is reassigned to 192 before the RPC runs
        await c.query(`UPDATE public.approval_steps SET approver_user_id = $2 WHERE id = $1`, [stepIds[0], U(192)])
        expect(await decide(c, requestId, stepIds[0], 'approved', 191, 191)).toBe('reassigned')
        expect((await c.query(`SELECT status FROM public.approval_steps WHERE id = $1`, [stepIds[0]])).rows[0].status).toBe('pending')
      })
    })

    it('two concurrent approvals of the same step: exactly one wins, the other gets conflict', async () => {
      const { requestId, stepIds } = await makeChain()
      const run = () => pool.query(`SELECT public.decide_approval_step($1::uuid,$2::uuid,'approved',$3::uuid,NULL,$3::uuid,NULL::uuid) AS r`, [requestId, stepIds[0], U(191)]).then(r => r.rows[0].r as string)
      const out = (await Promise.all([run(), run()])).sort()
      expect(out).toEqual(['advanced', 'conflict'])
      expect((await sql(`SELECT count(*)::int n FROM public.approval_steps WHERE request_id = $1 AND status = 'approved'`, [requestId]))[0].n).toBe(1)
    })
  })

  // ── cron + portal audit round 3 (migration 075) ─────────────────────────
  describe('cron/portal audit round 3 (migration 075)', () => {
    it('erase_user_pii pseudonymizes the actor\'s audit rows, removes identities + notifications, and leaves audit_log append-only', async () => {
      await makeUser(90, 'erase.me@test.dev'); await makeUser(91, 'bystander@test.dev'); await makeWorkspace(90, 90)
      await sql(`INSERT INTO public.audit_log (workspace_id, actor_id, actor_email, actor_name, ip_address, event_type, entity_type) VALUES ($1,$2,'erase.me@test.dev','Erase Me','203.0.113.9','test.a','x')`, [W(90), U(90)])
      await sql(`INSERT INTO public.audit_log (workspace_id, actor_id, actor_email, actor_name, ip_address, event_type, entity_type) VALUES ($1,$2,'bystander@test.dev','Bystander','203.0.113.10','test.b','x')`, [W(90), U(91)])
      await sql(`INSERT INTO public.audit_log (workspace_id, actor_id, actor_email, actor_name, event_type, entity_type, entity_name) VALUES ($1,$2,'bystander@test.dev','Bystander','member.invited','member','erase.me@test.dev')`, [W(90), U(91)])
      await sql(`INSERT INTO public.notifications (workspace_id, recipient_id, type, title, body) VALUES ($1,$2,'t','Hi Erase Me','body')`, [W(90), U(90)])
      await sql(`INSERT INTO auth.identities (provider_id, user_id, provider, identity_data, email) VALUES ('g-90', $1, 'google', '{"email":"erase.me@test.dev"}', 'erase.me@test.dev')`, [U(90)])

      const [{ r }] = await sql(`SELECT public.erase_user_pii($1, 'erase.me@test.dev') AS r`, [U(90)])
      expect(r.audit_actor_rows).toBe(1)
      expect(r.audit_target_rows).toBe(1)
      expect(r.notifications).toBe(1)
      expect(r.identities).toBeGreaterThanOrEqual(1)

      const mine = await sql(`SELECT actor_email, actor_name, ip_address FROM public.audit_log WHERE actor_id = $1`, [U(90)])
      expect(mine).toHaveLength(1)
      expect(mine[0].actor_email).toBe(`deleted-${U(90)}@deleted.scopegov.app`)
      expect(mine[0].actor_name).toBe('[Deleted user]')
      expect(mine[0].ip_address).toBeNull()
      // someone else's row is untouched, except the event that named the erased person as its target
      const other = await sql(`SELECT actor_name, ip_address, entity_name FROM public.audit_log WHERE actor_id = $1 ORDER BY event_type`, [U(91)])
      expect(other.map(o => o.actor_name)).toEqual(['Bystander', 'Bystander'])
      expect(other.find(o => o.entity_name === '[Deleted user]')).toBeTruthy()
      expect(await sql(`SELECT 1 FROM public.notifications WHERE recipient_id = $1`, [U(90)])).toHaveLength(0)
      expect(await sql(`SELECT 1 FROM auth.identities WHERE user_id = $1`, [U(90)])).toHaveLength(0)
      // the switch is transaction-local: the log is append-only again straight afterwards
      await expect(sql(`UPDATE public.audit_log SET actor_name = 'tampered'`)).rejects.toThrow()
      // idempotent
      const [{ r: again }] = await sql(`SELECT public.erase_user_pii($1, 'erase.me@test.dev') AS r`, [U(90)])
      expect(again.audit_actor_rows).toBe(0)
    })

    it('erase_user_pii and prune_snapshot_history are service-role only', async () => {
      await asRole('authenticated', U(90), async c => {
        expect(await denied(c, `SELECT public.erase_user_pii('${U(91)}'::uuid, NULL)`)).toBe(true)
        expect(await denied(c, `SELECT public.prune_snapshot_history(400)`)).toBe(true)
      })
      await asRole('anon', null, async c => {
        expect(await denied(c, `SELECT public.erase_user_pii('${U(91)}'::uuid, NULL)`)).toBe(true)
      })
    })

    it('prune_snapshot_history keeps recent daily rows and only month-start rows once old', async () => {
      await makeUser(92); await makeWorkspace(92, 92)
      const ins = (d: string) => sql(`INSERT INTO public.scope_health_snapshots (workspace_id, snapshot_date) VALUES ($1, $2::date)`, [W(92), d])
      await ins(new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10))        // recent: kept whatever the day
      await ins('2020-03-01')   // old month-start: kept
      await ins('2020-03-15')   // old mid-month: deleted
      await ins('2020-03-16')   // old mid-month: deleted
      const [{ r }] = await sql(`SELECT public.prune_snapshot_history(400) AS r`)
      expect(r.scope_health).toBeGreaterThanOrEqual(2)
      const left = await sql(`SELECT snapshot_date::text AS d FROM public.scope_health_snapshots WHERE workspace_id = $1 ORDER BY snapshot_date`, [W(92)])
      expect(left.map(x => x.d)).toContain('2020-03-01')
      expect(left.map(x => x.d)).not.toContain('2020-03-15')
      expect(left).toHaveLength(2)
      await expect(sql(`SELECT public.prune_snapshot_history(10)`)).rejects.toThrow(/>= 90/)
    })

    it('cron_run_history takes service writes and is closed to the API roles', async () => {
      await sql(`INSERT INTO public.cron_run_history (cron_name, ok, duration_ms, result) VALUES ('t', true, 12, '{"n":1}')`)
      await asRole('authenticated', U(90), async c => {
        expect(await denied(c, `SELECT * FROM public.cron_run_history`)).toBe(true)
      })
    })

    it('invoices carry the payment-claim columns with length guards', async () => {
      const cols = await sql(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='invoices' AND column_name LIKE 'payment_claim%'`)
      expect(cols.map(c => c.column_name).sort()).toEqual(['payment_claim_cleared_at', 'payment_claim_note', 'payment_claim_reference', 'payment_claimed_at'])
    })

    it('migration 075 can be applied a second time without error', async () => {
      await reapply('075_')
    })
  })

  // ── migration 076: billing defaults + configurable document numbering ─────
  describe('migration 076 — document numbering and billing defaults', () => {
    const assign = async (w: number, type: string) => (await sql(`SELECT public.assign_document_number($1,$2) AS n`, [W(w), type]))[0].n as string
    const setSeq = (w: number, type: string, prefix: string | null, next: number) =>
      sql(`SELECT public.set_document_sequence($1,$2,$3,$4)`, [W(w), type, prefix, next])

    beforeAll(async () => { await makeUser(95); await makeWorkspace(95, 95) })

    it('default numbering is unchanged: SOW-0001, SOW-0002, CO-0001, INV-0001', async () => {
      expect(await assign(95, 'sow')).toBe('SOW-0001')
      expect(await assign(95, 'sow')).toBe('SOW-0002')
      expect(await assign(95, 'co')).toBe('CO-0001')
      expect(await assign(95, 'invoice')).toBe('INV-0001')
    })

    it('a custom prefix and starting number are honoured, and the count carries on from there', async () => {
      await setSeq(95, 'invoice', 'ACME-INV', 121)
      expect(await assign(95, 'invoice')).toBe('ACME-INV-0121')
      expect(await assign(95, 'invoice')).toBe('ACME-INV-0122')
      // the other document types are untouched
      expect(await assign(95, 'sow')).toBe('SOW-0003')
    })

    it('an empty prefix goes back to the default, and the default is stored as NULL', async () => {
      await setSeq(95, 'invoice', '', 200)
      expect(await assign(95, 'invoice')).toBe('INV-0200')
      const [row] = await sql(`SELECT prefix FROM public.workspace_document_sequences WHERE workspace_id=$1 AND document_type='invoice'`, [W(95)])
      expect(row.prefix).toBeNull()
    })

    it('numbers past 9999 are no longer cut to four characters', async () => {
      await setSeq(95, 'co', null, 9999)
      expect(await assign(95, 'co')).toBe('CO-9999')
      expect(await assign(95, 'co')).toBe('CO-10000')
      expect(await assign(95, 'co')).toBe('CO-10001')
    })

    it('rejects a prefix that is malformed and a number out of range', async () => {
      await expect(setSeq(95, 'invoice', 'bad prefix', 5)).rejects.toThrow(/invalid_prefix/)
      await expect(setSeq(95, 'invoice', 'INV-', 5)).rejects.toThrow(/invalid_prefix/)
      await expect(setSeq(95, 'invoice', 'INV', 0)).rejects.toThrow(/invalid_next_number/)
      await expect(setSeq(95, 'invoice', 'INV', 100000000)).rejects.toThrow(/invalid_next_number/)
      await expect(setSeq(95, 'quote', 'INV', 5)).rejects.toThrow(/Invalid document_type/)
    })

    it('refuses a next number that would collide with one already issued under the same prefix', async () => {
      // Two issued invoices: INV-0200 (above) is handed out via the sequence, but the collision check reads
      // real documents, so insert numbered invoice rows directly (FK checks off — only the numbers matter here).
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        await c.query(`SET LOCAL session_replication_role = replica`)
        for (const n of ['INV-0050', 'INV-0060']) {
          await c.query(`INSERT INTO public.invoices (workspace_id, project_id, sow_id, title, amount, invoice_number, created_by)
                         VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'x', 100, $2, $3)`, [W(95), n, U(95)])
        }
        await c.query('COMMIT')
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }

      await expect(setSeq(95, 'invoice', 'INV', 60)).rejects.toThrow(/next_number_too_low:61/)
      await expect(setSeq(95, 'invoice', 'INV', 10)).rejects.toThrow(/next_number_too_low:61/)
      await setSeq(95, 'invoice', 'INV', 61)                                  // the earliest allowed
      expect(await assign(95, 'invoice')).toBe('INV-0061')
      // a DIFFERENT prefix has its own history, so the same low number is fine there
      await setSeq(95, 'invoice', 'BILL', 1)
      expect(await assign(95, 'invoice')).toBe('BILL-0001')
    })

    it('is closed to the API roles and open to the service role', async () => {
      for (const fn of [`public.set_document_sequence('${W(95)}','invoice','INV',5)`, `public.assign_document_number('${W(95)}','invoice')`]) {
        await asRole('authenticated', U(95), async c => { expect(await denied(c, `SELECT ${fn}`)).toBe(true) })
        await asRole('anon', null, async c => { expect(await denied(c, `SELECT ${fn}`)).toBe(true) })
      }
      await asRole('service_role', null, async c => { await c.query(`SELECT public.assign_document_number('${W(95)}','sow')`) })
    })

    it('billing defaults start neutral and are range-checked', async () => {
      const [ws] = await sql(`SELECT default_tax_rate, default_tax_inclusive, default_payment_terms_days FROM public.workspaces WHERE id=$1`, [W(95)])
      expect(Number(ws.default_tax_rate)).toBe(0)
      expect(ws.default_tax_inclusive).toBe(true)
      expect(ws.default_payment_terms_days).toBeNull()
      await sql(`UPDATE public.workspaces SET default_tax_rate = 16, default_payment_terms_days = 14 WHERE id=$1`, [W(95)])
      await expect(sql(`UPDATE public.workspaces SET default_tax_rate = 101 WHERE id=$1`, [W(95)])).rejects.toThrow(/default_tax_rate_range/)
      await expect(sql(`UPDATE public.workspaces SET default_payment_terms_days = 366 WHERE id=$1`, [W(95)])).rejects.toThrow(/payment_terms_days_range/)
    })

    it('migration 076 can be applied a second time without error, and keeps the settings', async () => {
      await reapply('076_', async c => {
        const { rows: [ws] } = await c.query(`SELECT default_tax_rate FROM public.workspaces WHERE id=$1`, [W(95)])
        expect(Number(ws.default_tax_rate)).toBe(16)
      })
    })
  })

  // ── Team & Invites independent pass — B1 (migration 112) ──────────────────
  describe('migration 112 — workspace restore never resurrects unaccepted invites', () => {
    it('reactivates real members only, drops leftover invite rows, and the CHECK forbids an active row without a user', async () => {
      await makeUser(120); await makeUser(121); await makeUser(122)
      await makeWorkspace(120, 120, 'agency')
      const [{ id: roleId }] = await sql(`SELECT id FROM public.roles WHERE workspace_id = $1 AND name = 'Account Manager'`, [W(120)])
      // a genuine former member (joined_at set, as accept/signup do)
      await sql(`INSERT INTO public.workspace_members (workspace_id, user_id, role_id, status, invited_email, joined_at) VALUES ($1,$2,$3,'active',$4, now())`, [W(120), U(121), roleId, 'u121@test.dev'])
      // pending invite for an address with no account, and one for an existing account that never accepted
      await sql(`INSERT INTO public.workspace_members (workspace_id, user_id, role_id, status, invited_email, invite_token) VALUES ($1,NULL,$2,'invited','nobody@test.dev','tok-a')`, [W(120), roleId])
      await sql(`INSERT INTO public.workspace_members (workspace_id, user_id, role_id, status, invited_email, invite_token) VALUES ($1,$2,$3,'invited','u122@test.dev','tok-b')`, [W(120), U(122), roleId])

      // What workspace/delete did BEFORE the fix: stamp every non-deactivated row.
      const stamp = new Date(Date.now() - 60_000).toISOString()
      await sql(`UPDATE public.workspaces SET deleted_at = $2 WHERE id = $1`, [W(120), stamp])
      await sql(`UPDATE public.workspace_members SET status = 'deactivated', deactivated_at = $2 WHERE workspace_id = $1 AND status <> 'deactivated'`, [W(120), stamp])

      await sql(`SELECT public.restore_workspace_atomic($1, $2)`, [W(120), U(120)])

      const rows = await sql(`SELECT user_id, status, invited_email FROM public.workspace_members WHERE workspace_id = $1 ORDER BY invited_email NULLS FIRST`, [W(120)])
      // no ghost: every ACTIVE row has a user, and the two invite rows are gone
      expect(rows.filter(r => r.status === 'active' && !r.user_id)).toEqual([])
      expect(rows.some(r => r.invited_email === 'nobody@test.dev')).toBe(false)
      expect(rows.some(r => r.invited_email === 'u122@test.dev')).toBe(false)
      const active = rows.filter(r => r.status === 'active').map(r => r.user_id).sort()
      expect(active).toEqual([U(120), U(121)].sort())

      await expect(sql(`INSERT INTO public.workspace_members (workspace_id, user_id, status) VALUES ($1, NULL, 'active')`, [W(120)]))
        .rejects.toThrow(/workspace_members_active_has_user/)
    })

    it('migration 112 can be applied a second time without error', async () => {
      await reapply('112_')
    })
  })


  // ── Workspace lifecycle independent pass (migration 116) ──────────────────
  describe('migration 116 — atomic workspace delete, and restore skips deleted accounts', () => {
    const joined = (w: number, u: number) => sql(`UPDATE public.workspace_members SET joined_at = now() WHERE workspace_id = $1 AND user_id = $2`, [W(w), U(u)])

    it('delete_workspace_atomic deactivates only ACTIVE members, reassigns active workspaces, and refuses a second delete', async () => {
      await makeUser(130); await makeUser(131); await makeUser(132)
      await makeWorkspace(130, 130, 'agency')
      await makeWorkspace(131, 132, 'agency')                         // a second, live workspace (the fallback)
      await addMember(131, 130, 'Account Manager'); await joined(131, 130)
      await sql(`UPDATE public.users SET active_workspace_id = $1 WHERE id = $2`, [W(130), U(130)])
      await addMember(130, 131, 'Account Manager'); await joined(130, 131)
      const [{ id: roleId }] = await sql(`SELECT id FROM public.roles WHERE workspace_id = $1 AND name = 'Account Manager'`, [W(130)])
      await sql(`INSERT INTO public.workspace_members (workspace_id, user_id, role_id, status, invited_email, invite_token) VALUES ($1,NULL,$2,'invited','pending@test.dev','tok-116')`, [W(130), roleId])

      const stamp = new Date(Date.now() - 60_000).toISOString()
      await sql(`SELECT public.delete_workspace_atomic($1, $2)`, [W(130), stamp])

      const [ws] = await sql(`SELECT deleted_at FROM public.workspaces WHERE id = $1`, [W(130)])
      expect(new Date(ws.deleted_at).toISOString()).toBe(stamp)
      const rows = await sql(`SELECT user_id, status, deactivated_at FROM public.workspace_members WHERE workspace_id = $1`, [W(130)])
      const pending = rows.find(r => r.user_id === null)!
      expect(pending.status).toBe('invited')                          // never stamped
      expect(pending.deactivated_at).toBeNull()
      for (const r of rows.filter(r => r.user_id)) {
        expect(r.status).toBe('deactivated')
        expect(new Date(r.deactivated_at).toISOString()).toBe(stamp)  // exact match restore relies on
      }
      const [u] = await sql(`SELECT active_workspace_id FROM public.users WHERE id = $1`, [U(130)])
      expect(u.active_workspace_id).toBe(W(131))

      // a second (overlapping / retried) delete must NOT re-stamp deleted_at
      await expect(sql(`SELECT public.delete_workspace_atomic($1, now())`, [W(130)])).rejects.toThrow(/already_deleted/)
      const [ws2] = await sql(`SELECT deleted_at FROM public.workspaces WHERE id = $1`, [W(130)])
      expect(new Date(ws2.deleted_at).toISOString()).toBe(stamp)

      // and restore therefore still brings the real members back
      await sql(`SELECT public.restore_workspace_atomic($1, $2)`, [W(130), U(130)])
      const active = (await sql(`SELECT user_id FROM public.workspace_members WHERE workspace_id = $1 AND status = 'active'`, [W(130)])).map(r => r.user_id).sort()
      expect(active).toEqual([U(130), U(131)].sort())
    })

    it('delete_workspace_atomic is closed to the API roles', async () => {
      await asRole('authenticated', U(130), async c => { expect(await denied(c, `SELECT public.delete_workspace_atomic('${W(131)}', now())`)).toBe(true) })
      await asRole('anon', null, async c => { expect(await denied(c, `SELECT public.delete_workspace_atomic('${W(131)}', now())`)).toBe(true) })
    })

    it('restore leaves a member whose account was deleted after the workspace was deleted deactivated', async () => {
      await makeUser(140); await makeUser(141); await makeUser(142)
      await makeWorkspace(140, 140, 'agency')
      await addMember(140, 141, 'Account Manager'); await joined(140, 141)
      await addMember(140, 142, 'Account Manager'); await joined(140, 142)
      await sql(`SELECT public.delete_workspace_atomic($1, now() - interval '1 minute')`, [W(140)])
      await sql(`UPDATE public.users SET deleted_at = now() WHERE id = $1`, [U(142)])   // account/delete after the workspace delete
      await sql(`SELECT public.restore_workspace_atomic($1, $2)`, [W(140), U(140)])
      const rows = await sql(`SELECT user_id, status FROM public.workspace_members WHERE workspace_id = $1`, [W(140)])
      expect(rows.find(r => r.user_id === U(141))!.status).toBe('active')
      expect(rows.find(r => r.user_id === U(142))!.status).toBe('deactivated')
    })

    it('admin restore skips deleted accounts too', async () => {
      await makeUser(143); await makeUser(144)
      await makeWorkspace(143, 143, 'agency')
      await addMember(143, 144, 'Account Manager'); await joined(143, 144)
      await sql(`SELECT public.admin_suspend_workspace($1)`, [W(143)])
      await sql(`UPDATE public.users SET deleted_at = now() WHERE id = $1`, [U(144)])
      await sql(`SELECT public.admin_restore_workspace($1)`, [W(143)])
      const rows = await sql(`SELECT user_id, status FROM public.workspace_members WHERE workspace_id = $1`, [W(143)])
      expect(rows.find(r => r.user_id === U(143))!.status).toBe('active')
      expect(rows.find(r => r.user_id === U(144))!.status).toBe('deactivated')
    })

    it('migration 116 can be applied a second time without error', async () => {
      await reapply('116_')
    })
  })


  // ── APPROVE_DOCUMENTS last-holder floor (migration 118) ───────────────────
  describe('APPROVE_DOCUMENTS last-holder floor (migration 118)', () => {
    // Owner (creator) drops their own APPROVE_DOCUMENTS by override, leaving user base+1 (Owner role) as the only holder.
    async function setup(base: number) {
      await makeUser(base); await makeUser(base + 1)
      await makeWorkspace(base, base, 'agency')
      const m2 = await addMember(base, base + 1, 'Owner')
      const [{ id: m1 }] = await sql(`SELECT id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [W(base), U(base)])
      await sql(`SELECT public.update_member_permissions_atomic($1,$2,false,NULL,true,'{"APPROVE_DOCUMENTS":false}'::jsonb)`, [W(base), m1])
      return { m1: m1 as string, m2 }
    }

    it('the sole approver cannot leave (also the path DELETE /api/account/delete uses)', async () => {
      await setup(200)
      // the non-creator approver is the leaver; the creator holds every other protected permission
      await expect(sql(`SELECT public.leave_workspace_atomic($1,$2)`, [W(200), U(201)])).rejects.toThrow(/would_orphan_permissions:APPROVE_DOCUMENTS/)
      const rows = await sql(`SELECT status FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [W(200), U(201)])
      expect(rows[0].status).toBe('active')
    })

    it('a leaver who is NOT the last approver is unaffected', async () => {
      await makeUser(202); await makeUser(203); await makeWorkspace(202, 202, 'agency')
      await addMember(202, 203, 'Owner')
      await sql(`SELECT public.leave_workspace_atomic($1,$2)`, [W(202), U(203)])
    })

    it('a workspace that never granted APPROVE_DOCUMENTS is not blocked from leaving', async () => {
      await makeUser(204); await makeUser(205); await makeWorkspace(204, 204, 'agency')
      const m2 = await addMember(204, 205, 'Owner')
      await sql(`SELECT public.update_member_permissions_atomic($1,$2,false,NULL,true,'{"APPROVE_DOCUMENTS":false}'::jsonb)`, [W(204), m2])
      await sql(`UPDATE public.roles SET permissions = permissions || '{"APPROVE_DOCUMENTS":false}'::jsonb WHERE workspace_id = $1 AND name = 'Owner'`, [W(204)]).catch(() => {})
      // nobody holds it now; 205 leaving must not be refused on APPROVE_DOCUMENTS grounds
      const r = await sql(`SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND status='active' AND (effective_permissions->'APPROVE_DOCUMENTS') = 'true'::jsonb`, [W(204)])
      if (r[0].n === 0) await sql(`SELECT public.leave_workspace_atomic($1,$2)`, [W(204), U(205)])
    })

    it('update_member_permissions_atomic refuses stripping the last approver', async () => {
      const { m2 } = await setup(206)
      await expect(sql(`SELECT public.update_member_permissions_atomic($1,$2,false,NULL,true,'{"APPROVE_DOCUMENTS":false}'::jsonb)`, [W(206), m2]))
        .rejects.toThrow(/would_orphan_permissions:APPROVE_DOCUMENTS/)
    })

    it('update_role_permissions_atomic refuses removing it from the only role that grants it', async () => {
      await setup(208)
      const [{ id: ownerRole }] = await sql(`SELECT id FROM public.roles WHERE workspace_id = $1 AND name = 'Owner'`, [W(208)])
      const [{ permissions }] = await sql(`SELECT permissions FROM public.roles WHERE id = $1`, [ownerRole])
      await expect(sql(`SELECT public.update_role_permissions_atomic($1,$2,$3::jsonb)`, [W(208), ownerRole, JSON.stringify({ ...permissions, APPROVE_DOCUMENTS: false })]))
        .rejects.toThrow(/would_orphan_permissions:APPROVE_DOCUMENTS/)
    })

    it('two concurrent strips of the last two approvers cannot both succeed', async () => {
      await makeUser(210); await makeUser(211); await makeWorkspace(210, 210, 'agency')
      const m2 = await addMember(210, 211, 'Owner')
      const [{ id: m1 }] = await sql(`SELECT id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [W(210), U(210)])
      const strip = (id: string) => pool.query(`SELECT public.update_member_permissions_atomic($1,$2,false,NULL,true,'{"APPROVE_DOCUMENTS":false}'::jsonb)`, [W(210), id])
      const outcomes = await Promise.allSettled([strip(m1), strip(m2)])
      expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1)
      const [{ n }] = await sql(`SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND status='active' AND (effective_permissions->'APPROVE_DOCUMENTS') = 'true'::jsonb`, [W(210)])
      expect(n).toBe(1)
    })

    it('retired permissions are not seeded on new workspaces and are stripped from existing roles', async () => {
      await makeUser(212); await makeWorkspace(212, 212, 'agency')
      const rows = await sql(`SELECT name FROM public.roles WHERE workspace_id = $1 AND permissions ?| ARRAY['MARK_DELIVERABLE_STATUS','MARK_PAYMENT_MILESTONES']`, [W(212)])
      expect(rows).toEqual([])
    })

    it('delete_workspace_atomic refuses a workspace with a recorded invoice payment (116 referenced a column that does not exist)', async () => {
      await makeUser(214); await makeWorkspace(214, 214, 'agency')
      const [client] = await sql(`INSERT INTO public.clients (workspace_id, name, email) VALUES ($1,'C','c214@x.dev') RETURNING id`, [W(214)])
      const [proj] = await sql(`INSERT INTO public.projects (workspace_id, client_id, name, type, created_by) VALUES ($1,$2,'P','web',$3) RETURNING id`, [W(214), client.id, U(214)])
      // Bypass FK checks for the document the invoice points at (only the payment -> invoice -> workspace chain matters here).
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        await c.query(`SET LOCAL session_replication_role = replica`)
        const { rows: [inv] } = await c.query(`INSERT INTO public.invoices (workspace_id, project_id, sow_id, title, amount, created_by) VALUES ($1,$2,gen_random_uuid(),'Inv',100,$3) RETURNING id`, [W(214), proj.id, U(214)])
        await c.query(`INSERT INTO public.invoice_payments (invoice_id, amount, paid_at, recorded_by) VALUES ($1,10,current_date,$2)`, [inv.id, U(214)])
        await c.query('COMMIT')
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
      await expect(sql(`SELECT public.delete_workspace_atomic($1, now())`, [W(214)])).rejects.toThrow(/blocked_by_live_documents/)
      const [ws] = await sql(`SELECT deleted_at FROM public.workspaces WHERE id = $1`, [W(214)])
      expect(ws.deleted_at).toBeNull()
    })

    it('migration 118 can be applied a second time without error', async () => {
      await reapply('118_')
    })
  })

})
