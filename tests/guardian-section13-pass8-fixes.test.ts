// tests/guardian-section13-pass8-fixes.test.ts
//
// Regression guards for Guardian / scope governance, independent pass 8:
//   B1 - reclassifyCheck ignored read / claim errors (outage looked like not_found / claimed / a harmless skip)
//   B2 - a malformed id on check / scope-adjustment / retry was a 500 instead of a 404
//   B3 - escalate: a failed assignee lookup was reported as "not an active member"
//   B4 - a renamed CO-added deliverable was never matched by a later credit CO

import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createFakeSupabase } from './helpers/fake-supabase'

vi.mock('@/lib/ai/guardian', async (orig) => {
  const actual: any = await orig()
  return { ...actual, getEmbedding: vi.fn(async () => { throw new Error('no embeddings in tests') }) }
})

import { netAmendmentDeliverables } from '@/lib/ai/guardian'
import { reclassifyCheck, GUARDIAN_SYSTEM_ACTOR } from '@/lib/ai/guardian-pipeline'

const root = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

describe('B4 - renames are followed when netting credit COs', () => {
  const co = { id: 'a1', title: 'Branding CO', added_deliverables: ['Logo design'], created_at: '2026-01-01T00:00:00Z' }
  const rename = { old_value: 'Logo design', new_value: 'Brand logo', adjusted_at: '2026-02-01T00:00:00Z' }
  const credit = { id: 'a2', title: 'Credit', added_deliverables: [], removed_deliverables: ['Brand logo'], created_at: '2026-03-01T00:00:00Z' }

  it('a credit CO naming the NEW title cancels the CO that added the OLD one', () => {
    expect(netAmendmentDeliverables([co, credit], [rename])).toEqual([])
  })
  it('without the rename information the stale add survives (what the bug was)', () => {
    expect(netAmendmentDeliverables([co, credit]).map(a => a.added_deliverables)).toEqual([['Logo design']])
  })
  it('chained renames resolve to the final title', () => {
    const r2 = { old_value: 'Brand logo', new_value: 'Logo suite', adjusted_at: '2026-02-15T00:00:00Z' }
    const c = { ...credit, removed_deliverables: ['Logo suite'] }
    expect(netAmendmentDeliverables([co, c], [r2, rename])).toEqual([])
  })
  it('a rename made BEFORE the CO does not touch that CO', () => {
    const early = { ...rename, adjusted_at: '2025-12-01T00:00:00Z' }
    expect(netAmendmentDeliverables([co, credit], [early]).map(a => a.added_deliverables)).toEqual([['Logo design']])
  })
  it('a re-purchase after the removal is still kept', () => {
    const rebuy = { id: 'a3', title: 'Rebuy', added_deliverables: ['Brand logo'], created_at: '2026-04-01T00:00:00Z' }
    const out = netAmendmentDeliverables([co, credit, rebuy], [rename])
    expect(out.map(a => a.id)).toEqual(['a3'])
  })
  it('unrelated renames and missing created_at leave amendments unchanged', () => {
    const old = [{ id: 'a', title: 'A', added_deliverables: ['X'] }]
    expect(netAmendmentDeliverables(old, [rename])).toEqual(old)
    expect(netAmendmentDeliverables([co], [{ old_value: 'Other', new_value: 'Thing', adjusted_at: '2026-02-01T00:00:00Z' }])).toEqual([co])
  })
  it('the pipeline feeds the deliverables renames into the net computation', () => {
    const src = read('lib/ai/guardian-pipeline.ts')
    expect(src).toMatch(/from\('scope_adjustments'\)[\s\S]*eq\('field', 'deliverables'\)/)
    expect(src).toContain('netAmendmentDeliverables(data || [], renameRows || [])')
  })
})

describe('B1 - reclassifyCheck reports real failures instead of skipping', () => {
  const rows = () => ({
    guardian_checks: [{ id: 'c1', project_id: 'p1', workspace_id: 'w1', content: 'More please', is_duplicate: false, outcome: 'pending', classification_failed: true, classification_attempts: 0, source: 'paste', source_metadata: null, embedding: null }],
    projects: [{ id: 'p1', name: 'Acme', status: 'Active', stall_reason: null, deleted_at: null, workspace_id: 'w1',
      workspaces: { id: 'w1', guardian_sensitivity_tier: 'medium', deleted_at: null },
      project_scope_snapshot: { deliverables: [{ title: 'Site' }], out_of_scope: [] } }],
  })
  const opts = { actor: GUARDIAN_SYSTEM_ACTOR, auditEvent: 'check.retried', emailPath: 'retry' }

  it('a failed check read throws (was: not_found)', async () => {
    const fake = createFakeSupabase(rows(), { errors: [{ table: 'guardian_checks', op: 'select', message: 'boom' }] })
    await expect(reclassifyCheck(fake.client as any, 'c1', opts)).rejects.toThrow(/check read failed/)
  })
  it('a malformed id (22P02) is still a plain not_found', async () => {
    const fake = createFakeSupabase(rows(), { errors: [{ table: 'guardian_checks', op: 'select', code: '22P02', message: 'invalid input syntax for type uuid' }] })
    await expect(reclassifyCheck(fake.client as any, 'nope', opts)).resolves.toEqual({ status: 'skipped', reason: 'not_found' })
  })
  it('a failed project read throws (was: not_found)', async () => {
    const fake = createFakeSupabase(rows(), { errors: [{ table: 'projects', op: 'select', message: 'boom' }] })
    await expect(reclassifyCheck(fake.client as any, 'c1', opts)).rejects.toThrow(/project read failed/)
  })
  it('a failed claim write throws (was: "claimed")', async () => {
    const fake = createFakeSupabase(rows(), { errors: [{ table: 'guardian_checks', op: 'update', message: 'boom' }] })
    await expect(reclassifyCheck(fake.client as any, 'c1', opts)).rejects.toThrow(/claim failed/)
  })
  it('the sweep fails the run when every attempted item threw', () => {
    const src = read('app/api/cron/guardian-health/route.ts')
    expect(src).toMatch(/errored >= 3 && errored === attempted/)
  })
})

describe('B2 / B3 - route-level error handling', () => {
  it('check, scope-adjustment and retry treat 22P02 as not-found', () => {
    expect(read('app/api/guardian/check/route.ts')).toMatch(/!== 'PGRST116' && \(projectErr as any\)\.code !== '22P02'/)
    expect(read('app/api/guardian/scope-adjustment/route.ts')).toMatch(/!== 'PGRST116' && projectErr\.code !== '22P02'/)
    expect(read('app/api/guardian/checks/[id]/retry/route.ts')).toMatch(/!== 'PGRST116' && checkErr\.code !== '22P02'/)
  })
  it('escalate reads the assignee with maybeSingle and throws on a real error', () => {
    const src = read('app/api/guardian/flags/[id]/route.ts')
    expect(src).toMatch(/\.maybeSingle\(\)\s*\n\s*if \(memberErr && memberErr\.code !== '22P02'\) throw/)
    expect(src).toMatch(/typeof escalateTo !== 'string'/)
  })
})
