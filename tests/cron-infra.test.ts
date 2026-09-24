import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as any,
  alerts: [] as any[],
  missed: [] as any[],
  heartbeats: [] as any[],
  history: [] as any[],
}))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-alert', () => ({
  alertCronFailure: async (...a: any[]) => { h.alerts.push(a) },
  alertCronMissedHeartbeat: async (_s: any, name: string, message: string, cooldown: number) => { h.missed.push({ name, message, cooldown }) },
}))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async (_s: any, name: string, result: any) => { h.heartbeats.push({ name, result }) } }))

import { CRON_MANIFEST, heartbeatExpectations } from '@/lib/cron/manifest'
import { POST as watchdog } from '@/app/api/cron/cron-heartbeat-watchdog/route'
import { POST as notificationCleanup } from '@/app/api/cron/notification-cleanup/route'
import { pruneInBatches } from '@/lib/utils/retention'

const CRON_DIR = path.join(__dirname, '..', 'app', 'api', 'cron')
const call = async (fn: any) => { const res = await fn({} as any); return { status: res.status, body: await res.json() } }

beforeEach(() => {
  h.alerts.length = 0; h.missed.length = 0; h.heartbeats.length = 0; h.history.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('cron manifest — the in-repo list of what runs', () => {
  const dirs = fs.readdirSync(CRON_DIR).filter(d => fs.existsSync(path.join(CRON_DIR, d, 'route.ts')))

  it('has an entry for every route under app/api/cron, and no entry without a route', () => {
    expect(CRON_MANIFEST.map(c => c.name).sort()).toEqual([...dirs].sort())
  })

  it('has no duplicate names and sane tolerances', () => {
    const names = CRON_MANIFEST.map(c => c.name)
    expect(new Set(names).size).toBe(names.length)
    const interval: Record<string, number> = { 'every-15-min': 0.25, hourly: 1, daily: 24, weekly: 168 }
    for (const c of CRON_MANIFEST) {
      // tolerance must exceed the schedule interval, or a healthy cron would page between runs
      expect(c.toleranceHours, c.name).toBeGreaterThan(interval[c.cadence])
      expect(c.schedule.split(' '), c.name).toHaveLength(5)
    }
  })

  it('every route exports POST and GET, authenticates with the shared verifier, and (unless it is the watchdog) records a heartbeat', () => {
    for (const d of dirs) {
      const src = fs.readFileSync(path.join(CRON_DIR, d, 'route.ts'), 'utf8')
      expect(src, `${d} exports POST`).toMatch(/export async function POST/)
      expect(src, `${d} exports GET`).toMatch(/export const GET = POST/)
      expect(src, `${d} verifies the cron secret`).toMatch(/verifyCronSecret\(/)
      if (d !== 'cron-heartbeat-watchdog') expect(src, `${d} records a heartbeat`).toMatch(/recordCronHeartbeat|new CronRun\(/)
    }
  })

  it("the watchdog's expectations are derived from the manifest (everything with a heartbeat, nothing else)", () => {
    const exp = heartbeatExpectations()
    expect(Object.keys(exp).sort()).toEqual(CRON_MANIFEST.filter(c => c.heartbeat).map(c => c.name).sort())
    expect(exp['cron-heartbeat-watchdog']).toBeUndefined()
  })

  it('every cron the GitHub backup workflow calls is in the manifest and flagged githubBackup', () => {
    const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'vercel-crons.yml'), 'utf8')
    const called = Array.from(wf.matchAll(/NAME="([a-z-]+)"/g)).map(m => m[1])
    expect(called.length).toBeGreaterThan(0)
    for (const n of called) expect(CRON_MANIFEST.find(c => c.name === n)?.githubBackup, n).toBe(true)
    expect(CRON_MANIFEST.filter(c => c.githubBackup).map(c => c.name).sort()).toEqual([...called].sort())
  })
})

describe('cron-heartbeat-watchdog', () => {
  const freshAll = () => Object.keys(heartbeatExpectations()).map(n => ({ cron_name: n, last_ok_at: new Date().toISOString() }))
  const stale = (name: string, hoursAgo: number) => ({ cron_name: name, last_ok_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() })
  const withStale = (...s: Row[]) => { const names = new Set(s.map(x => x.cron_name)); return [...freshAll().filter(r => !names.has(r.cron_name)), ...s] }

  it('is quiet when everything is fresh', async () => {
    h.db = createFakeSupabase({ cron_heartbeats: freshAll() })
    const { body } = await call(watchdog)
    expect(body.stale).toEqual([]); expect(h.missed).toHaveLength(0)
  })

  it('pages a single stale cron, re-paging only every 6-24h (NOT hourly, as it used to)', async () => {
    h.db = createFakeSupabase({ cron_heartbeats: withStale(stale('payment-overdue', 40)) })
    await call(watchdog)
    expect(h.missed).toHaveLength(1)
    expect(h.missed[0].name).toBe('payment-overdue')
    expect(h.missed[0].cooldown).toBeGreaterThanOrEqual(6 * 3_600_000)
    expect(h.missed[0].cooldown).toBeLessThanOrEqual(24 * 3_600_000)
  })

  it('a cron that has NEVER recorded a heartbeat is reported', async () => {
    h.db = createFakeSupabase({ cron_heartbeats: freshAll().filter(r => r.cron_name !== 'signing-integrity') })
    const { body } = await call(watchdog)
    expect(body.stale.join(' ')).toMatch(/signing-integrity: last success never recorded/)
  })

  it('sends ONE digest instead of a page per cron when four or more are stale (a wide outage has one cause)', async () => {
    h.db = createFakeSupabase({ cron_heartbeats: withStale(...['co-expiry', 'sow-expiry', 'invoice-expiry', 'payment-overdue', 'approval-stall'].map(n => stale(n, 60))) })
    const { body } = await call(watchdog)
    expect(body.stale).toHaveLength(5)
    expect(h.missed).toHaveLength(1)
    expect(h.missed[0].name).toBe('__many__')
    expect(h.missed[0].message).toMatch(/5 crons have gone quiet/)
  })

  it('a failed heartbeat read is a loud failure, not "nothing stale"', async () => {
    h.db = createFakeSupabase({ cron_heartbeats: [] }, { errors: [{ table: 'cron_heartbeats', op: 'select', message: 'boom' }] })
    const { status } = await call(watchdog)
    expect(status).toBe(500); expect(h.alerts).toHaveLength(1)
  })
})

describe('pruneInBatches (retention helper)', () => {
  const rows = (n: number, extra: Row = {}) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, created_at: '2020-01-01T00:00:00.000Z', ...extra }))

  it('deletes matching rows in bounded batches and leaves the rest', async () => {
    const db = createFakeSupabase({ t: [...rows(25), { id: 'keep', created_at: '2999-01-01T00:00:00.000Z' }] })
    const r = await pruneInBatches(db.client, 't', q => q.lt('created_at', '2021-01-01'), { batch: 10 })
    expect(r).toEqual({ deleted: 25, truncated: false })
    expect(db.tables.t.map((x: Row) => x.id)).toEqual(['keep'])
    // 3 selects (10, 10, 5) and 3 deletes — never one giant statement
    expect(db.calls.filter(c => c.op === 'delete')).toHaveLength(3)
  })

  it('reports truncation when it runs out of batch budget, so the caller can say "more remains"', async () => {
    const db = createFakeSupabase({ t: rows(50) })
    const r = await pruneInBatches(db.client, 't', q => q.lt('created_at', '2021-01-01'), { batch: 10, maxBatches: 2 })
    expect(r).toEqual({ deleted: 20, truncated: true })
    expect(db.tables.t).toHaveLength(30)
  })

  it('throws on a database error instead of pretending nothing matched', async () => {
    const db = createFakeSupabase({ t: rows(5) }, { errors: [{ table: 't', op: 'delete', message: 'statement timeout' }] })
    await expect(pruneInBatches(db.client, 't', q => q.lt('created_at', '2021-01-01'))).rejects.toThrow(/statement timeout/)
  })
})

describe('cron/notification-cleanup', () => {
  const old = (id: string, extra: Row = {}) => ({ id, created_at: '2020-01-01T00:00:00.000Z', ...extra })
  const tablesFor = () => ({
    notifications: [old('n1', { read: true }), old('n2', { read: false }), { id: 'n3', read: true, created_at: new Date().toISOString() }],
    email_log: [old('e1')], ai_usage_log: [old('a1'), { id: 'a2', created_at: new Date().toISOString() }], cron_run_history: [old('c1')],
  })

  it('prunes notifications, email_log, ai_usage_log (never pruned before) and cron_run_history, and downsamples snapshots', async () => {
    h.db = createFakeSupabase(tablesFor(), { rpc: { prune_snapshot_history: () => ({ data: { scope_health: 4, reconciliation: 9 } }) } })
    const { status, body } = await call(notificationCleanup)
    expect(status).toBe(200)
    expect(body).toMatchObject({ readPurged: 1, oldPurged: 1, emailLogPurged: 1, aiUsagePurged: 1, cronHistoryPurged: 1 })
    expect(body.snapshotsDownsampled).toEqual({ scope_health: 4, reconciliation: 9 })
    expect(h.db.tables.notifications.map((r: Row) => r.id)).toEqual(['n3'])
    expect(h.db.tables.ai_usage_log.map((r: Row) => r.id)).toEqual(['a2'])
    expect(h.db.rpcCalls[0]).toEqual({ name: 'prune_snapshot_history', args: { p_keep_daily_days: 400 } })
    expect(h.heartbeats).toHaveLength(1)
  })

  it('a failing step alerts IMMEDIATELY (it used to return 207 and wait ~27h for the watchdog) and withholds the heartbeat; sibling steps still run', async () => {
    h.db = createFakeSupabase(tablesFor(), { rpc: { prune_snapshot_history: () => ({ data: {} }) }, errors: [{ table: 'email_log', op: 'delete', message: 'timeout' }] })
    const { status, body } = await call(notificationCleanup)
    expect(status).toBe(500)
    expect(body.errors.join(' ')).toMatch(/prune email_log/)
    expect(h.alerts).toHaveLength(1)
    expect(h.heartbeats).toHaveLength(0)
    expect(h.db.tables.ai_usage_log.map((r: Row) => r.id)).toEqual(['a2']) // later steps were not skipped
  })
})
