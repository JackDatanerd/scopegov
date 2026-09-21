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
      expect(rows.map(r => r.proname).sort()).toEqual(['immutable_unaccent', 'is_active_workspace_member', 'middleware_gate_state'])
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
    it('the seeded Owner role holds exactly the 26 real permissions (no stale EXPORT_DATA key)', async () => {
      await makeUser(50); await makeWorkspace(50, 50)
      const [r] = await sql(`SELECT permissions FROM public.roles WHERE workspace_id = $1 AND name = 'Owner'`, [W(50)])
      expect(Object.keys(r.permissions)).toHaveLength(26)
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
      const f = fs.readdirSync(MIGRATIONS).find(x => x.startsWith('068_'))!
      await pool.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    })

    it('the storage buckets carry size and mime limits', async () => {
      const rows = await sql(`SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id IN ('logos','flag-evidence') ORDER BY id`)
      expect(rows.map(r => r.id)).toEqual(['flag-evidence', 'logos'])
      for (const r of rows) { expect(Number(r.file_size_limit)).toBeGreaterThan(0); expect(r.allowed_mime_types.length).toBeGreaterThan(0) }
      expect(rows.find(r => r.id === 'logos')!.allowed_mime_types).toEqual(['image/png', 'image/jpeg'])
    })
  })
})
