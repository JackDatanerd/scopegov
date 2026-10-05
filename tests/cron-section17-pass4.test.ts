// tests/cron-section17-pass4.test.ts
//
// Regression tests for the section-17 (cron) independent pass 4:
//   B1 — alertCronFailure turned a plain PostgREST error object into "[object Object]"
//   B2 — trial-warning stored the recipient's email in append-only audit metadata (and deduped on it)
//   B3 — emails embedded in cron step / row failure text were persisted and mailed to ops
//   B4 — a failed bell write (notifyMembersWithPermission returns false) after an irreversible state change was invisible
//   B5 — trial-warning dedupe lookups ignored query errors
//   B6 — the nightly rollup could upsert a degraded open-ended-retainer figure; contractedValue was not floored at 0
//   B7 — workspace-purge's 7-year cutoff ignored leap days

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFakeSupabase, type Row } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({ db: null as any, notify: true as boolean, notified: [] as any[], sent: [] as any[], history: [] as any[], reminder: 'sent' as string, positionsStrict: undefined as any }))

vi.mock('@/lib/utils/verify-cron', () => ({ verifyCronSecret: () => true }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db.client }))
vi.mock('@/lib/utils/cron-heartbeat', () => ({ recordCronHeartbeat: async () => {} }))
vi.mock('@/lib/utils/cron-history', () => ({ recordCronRunHistory: async (_s: any, _n: string, e: any) => { h.history.push(e) } }))
vi.mock('@/lib/email/send', () => ({ sendEmail: async (p: any) => { h.sent.push(p); return { ok: true, id: 'x' } } }))
vi.mock('@/lib/email/from', () => ({ systemFrom: () => 'ops@x.test' }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: async (_s: any, p: any) => { h.notified.push(p); return h.notify } }))
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: async () => [] }))
vi.mock('@/lib/email/templates', () => ({ sendCoStalledEmail: async () => ({ ok: true }), sendSowStalledEmail: async () => ({ ok: true }) }))
vi.mock('@/lib/utils/audit', () => ({
  insertAuditRow: async (_s: any, row: any) => { h.db.tables.audit_log ||= []; h.db.tables.audit_log.push({ id: `a${h.db.tables.audit_log.length}`, created_at: new Date().toISOString(), ...row }); return true },
}))
vi.mock('@/lib/approvals/engine', () => ({
  healStuckSends: async () => [], documentLabelFor: (t: string) => t, sendApprovalReminder: async () => h.reminder,
}))

import { describeError, alertCronFailure } from '@/lib/utils/cron-alert'
import { CronRun, redactEmails } from '@/lib/utils/cron-run'
import { POST as coStall } from '@/app/api/cron/co-stall/route'
import { POST as sowStall } from '@/app/api/cron/sow-stall/route'
import { POST as approvalStall } from '@/app/api/cron/approval-stall/route'
import { computeContractPositions } from '@/lib/reports/contract-position'

const DAY = 86_400_000
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString()
const call = async (fn: any) => { const res = await fn({} as any); return { status: res.status, body: await res.json() } }
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
// Source with `//` comment lines removed — so assertions about what the CODE does aren't tripped by explanatory comments.
const code = (p: string) => read(p).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

beforeEach(() => {
  h.notify = true; h.notified.length = 0; h.sent.length = 0; h.history.length = 0; h.reminder = 'sent'
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('B1 — plain-object errors keep their message', () => {
  const pgErr = { message: 'canceling statement due to statement timeout', code: '57014', details: null, hint: null }

  it('describeError', () => {
    expect(describeError(pgErr)).toContain('statement timeout')
    expect(describeError(pgErr)).toContain('57014')
    expect(describeError('plain')).toBe('plain')
    expect(describeError(new Error('boom'))).toContain('boom')
    expect(describeError({})).toBe('{}')
    expect(describeError({ a: 1 })).not.toContain('[object Object]')
  })

  it('alertCronFailure records and emails the real message, never "[object Object]"', async () => {
    process.env.OPS_ALERT_EMAIL = 'ops@x.test'
    const svc: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }), upsert: async () => ({}) }) }
    await alertCronFailure(svc, 'project-purge', pgErr)
    expect(h.history[0].error).toContain('statement timeout')
    expect(h.sent[0].html).toContain('statement timeout')
    expect(h.sent[0].html).not.toContain('[object Object]')
  })

  it('both purge crons hand alertCronFailure an Error built from the lookup failure', () => {
    for (const name of ['project-purge', 'workspace-purge']) {
      const src = read(`app/api/cron/${name}/route.ts`)
      expect(src).toMatch(/const lookupError = new Error\(`candidate lookup failed: \$\{findErr\.message\}/)
      expect(src).toContain(`alertCronFailure(service, '${name}', lookupError)`)
      expect(src).not.toMatch(new RegExp(`alertCronFailure\\(service, '${name}', findErr\\)`))
    }
  })
})

describe('B3 — emails are masked in cron failure text', () => {
  it('redactEmails', () => {
    expect(redactEmails('a.b+c@Ex-ample.co.uk: 422 bad')).toBe('[email]: 422 bad')
    expect(redactEmails('no address here')).toBe('no address here')
    expect(redactEmails('x@y.io and z@w.com')).toBe('[email] and [email]')
  })

  it('CronRun.rowError / step persist the masked text', async () => {
    const run = new CronRun({ from: () => ({ upsert: async () => ({}) }) }, 'test-cron')
    run.rowError('trial warning w1 → person@real.test', new Error('Invalid `to` field: person@real.test'))
    await run.step('step for boss@real.test', async () => { throw new Error('nope') })
    await run.finish()
    const blob = JSON.stringify(h.history)
    expect(blob).not.toContain('real.test')
    expect(blob).toContain('[email]')
  })

  it('payment-overdue no longer puts recipient addresses in its reminder failure text', () => {
    const src = read('app/api/cron/payment-overdue/route.ts')
    expect(src).not.toMatch(/sendErrors\.push\(`\$\{r\.email\}/)
  })
})

describe('B4 — a lost bell after an irreversible change is surfaced', () => {
  it('co-stall: CO is stalled and the failed notification is reported as a row error', async () => {
    h.notify = false
    h.db = createFakeSupabase({ change_orders: [{ id: 'c1', title: 'T', status: 'awaiting_response', sent_at: ago(6), project_id: 'p1', workspace_id: 'w1', workspaces: { deleted_at: null }, projects: { name: 'P', clients: { name: 'C' } } }] })
    const { status, body } = await call(coStall)
    expect(status).toBe(200)
    expect(h.db.tables.change_orders[0].status).toBe('stalled')
    expect(body.rowErrors?.join(' ')).toMatch(/bell notification failed/)
  })

  it('co-stall: no row error when the bell is written', async () => {
    h.db = createFakeSupabase({ change_orders: [{ id: 'c1', title: 'T', status: 'awaiting_response', sent_at: ago(6), project_id: 'p1', workspace_id: 'w1', workspaces: { deleted_at: null }, projects: { name: 'P', clients: { name: 'C' } } }] })
    const { body } = await call(coStall)
    expect(body.rowErrors).toBeUndefined()
    expect(body.stalled).toBe(1)
  })

  it('sow-stall: reports the failed bell', async () => {
    h.notify = false
    h.db = createFakeSupabase({
      sow_documents: [{ id: 's1', project_id: 'p1', workspace_id: 'w1', status: 'awaiting_signature', sent_at: ago(8), workspaces: { deleted_at: null }, projects: { id: 'p1', name: 'P', status: 'Awaiting Signature', clients: { name: 'C' } } }],
      projects: [{ id: 'p1', status: 'Awaiting Signature' }],
    })
    const { body } = await call(sowStall)
    expect(h.db.tables.projects[0].status).toBe('Stalled')
    expect(body.rowErrors?.join(' ')).toMatch(/bell notification failed/)
  })

  it('approval-stall: a failed send-failure escalation is NOT bumped, so it is retried next run', async () => {
    h.notify = false
    h.db = createFakeSupabase({ approval_requests: [{ id: 'r1', workspace_id: 'w1', project_id: 'p1', document_type: 'sow', status: 'approved', send_failed_at: ago(5), send_failed_reason: 'x', updated_at: ago(5), send_failure_alerts: 0, workspaces: { deleted_at: null } }] })
    const before = h.db.tables.approval_requests[0].updated_at
    const { body } = await call(approvalStall)
    expect(h.db.tables.approval_requests[0].updated_at).toBe(before)
    expect(body.sendFailureEscalated).toBe(0)
    expect(body.rowErrors?.join(' ')).toMatch(/will retry next run/)
  })

  it('approval-stall: a successful send-failure escalation is still bumped and counted', async () => {
    h.db = createFakeSupabase({ approval_requests: [{ id: 'r1', workspace_id: 'w1', project_id: 'p1', document_type: 'sow', status: 'approved', send_failed_at: ago(5), send_failed_reason: 'x', updated_at: ago(5), send_failure_alerts: 0, workspaces: { deleted_at: null } }] })
    const before = h.db.tables.approval_requests[0].updated_at
    const { body } = await call(approvalStall)
    expect(h.db.tables.approval_requests[0].updated_at).not.toBe(before)
    expect(body.sendFailureEscalated).toBe(1)
    expect(h.db.tables.approval_requests[0].send_failure_alerts).toBe(1)
  })
})

describe('B2 / B5 — trial-warning audit rows carry no email; dedupe errors are not "not sent yet"', () => {
  const src = code('app/api/cron/trial-warning/route.ts')
  it('dedupes on user_id and writes user_id, never the address', () => {
    expect(src).toContain(".eq('metadata->>user_id', person.id)")
    expect(src).toContain('user_id: person.id')
    expect(src).not.toMatch(/sent_to/)
    expect(src).not.toMatch(/rowError\(`[^`]*person\.email/)
  })
  it('reads the error of both dedupe lookups', () => {
    expect(src).toMatch(/bellErr/)
    expect(src).toMatch(/throw new Error\(`bell dedupe lookup failed/)
    expect(src).toMatch(/throw new Error\(`warning dedupe lookup failed/)
  })
  it('migration 127 backfills user_id, strips sent_to under the audit bypass, and restores the flag', () => {
    const sql = read('supabase/migrations/127_trial_warning_audit_no_email.sql')
    expect(sql).toMatch(/set_config\('app\.audit_purge', 'on', true\)/)
    expect(sql).toMatch(/metadata \|\| jsonb_build_object\('user_id'/)
    expect(sql).toMatch(/metadata - 'sent_to'/)
    expect(sql.match(/set_config\('app\.audit_purge', 'off', true\)/g)!.length).toBeGreaterThanOrEqual(2)
  })
})

describe('B6 — rollup figures', () => {
  const retainer = { id: 'p1', contract_value: 1000, type: 'retainer', retainer_duration_months: null }
  const failingMonths = () => createFakeSupabase({ payment_milestones: [] }, { errors: [{ table: 'payment_milestones', op: 'select', message: 'boom' }] }).client

  it('lenient (display) mode still degrades to one month', async () => {
    const out = await computeContractPositions(failingMonths(), [retainer])
    expect(out.get('p1')!.contractedValue).toBe(1000)
  })
  it('strict (rollup) mode throws instead of producing a degraded figure', async () => {
    await expect(computeContractPositions(failingMonths(), [retainer], { strict: true })).rejects.toThrow(/retainer months lookup failed/)
  })
  it('contractedValue is floored at zero', async () => {
    const db = createFakeSupabase({ amendments: [{ id: 'a1', project_id: 'p2', financial_impact: -5000, change_orders: null }] })
    const out = await computeContractPositions(db.client, [{ id: 'p2', contract_value: 1000, type: 'fixed' }])
    expect(out.get('p2')!.contractedValue).toBe(0)
  })
  it('the rollup route requests strict mode', () => {
    expect(read('app/api/cron/reconciliation-rollup/route.ts')).toMatch(/computeContractPositions\(service, projects, \{ strict: true \}\)/)
  })
})

describe('B7 — workspace-purge cutoff is seven calendar years', () => {
  it('uses setUTCFullYear, not 7*365 days', () => {
    const src = code('app/api/cron/workspace-purge/route.ts')
    expect(src).toMatch(/setUTCFullYear\(cutoff7\.getUTCFullYear\(\) - 7\)/)
    expect(src).not.toMatch(/7 \* 365/)
  })
  it('a leap-day-spanning span is longer than 7*365 days', () => {
    const d = new Date(Date.UTC(2026, 8, 30)); d.setUTCFullYear(d.getUTCFullYear() - 7)
    expect((Date.UTC(2026, 8, 30) - d.getTime()) / DAY).toBeGreaterThan(7 * 365)
  })
})
