import { describe, it, expect } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'
import { reclassifyCheck, GUARDIAN_SYSTEM_ACTOR } from '@/lib/ai/guardian-pipeline'
import { MAX_CLASSIFY_CHARS, MAX_CHECK_CONTENT_CHARS } from '@/lib/ai/guardian'

describe('Guardian section 13 — independent pass fixes', () => {
  it('the classifier reads everything that can be stored (was silently truncated at 6,000 of 20,000 chars)', () => {
    expect(MAX_CLASSIFY_CHARS).toBeGreaterThanOrEqual(MAX_CHECK_CONTENT_CHARS)
  })

  it('a failed check later found to be a duplicate is no longer classification_failed (no dead Retry button / endless ops alert)', async () => {
    const fake = createFakeSupabase({
      guardian_checks: [{
        id: 'chk-failed', project_id: 'p1', workspace_id: 'w1', content: 'Please add a dark mode',
        is_duplicate: false, outcome: 'pending', classification_failed: true, classification_attempts: 1,
        source: 'paste', source_metadata: null, embedding: [0.1, 0.1, 0.1, 0.1],
      }],
      projects: [{
        id: 'p1', name: 'Proj', status: 'Active', deleted_at: null, workspace_id: 'w1',
        workspaces: { id: 'w1', guardian_sensitivity_tier: 'medium', deleted_at: null },
        project_scope_snapshot: { deliverables: [], out_of_scope: [] },
      }],
    }, { rpc: { guardian_find_duplicate_check: () => ({ data: 'chk-earlier-classified', error: null }) } })

    const res = await reclassifyCheck(fake.client as any, 'chk-failed', {
      actor: GUARDIAN_SYSTEM_ACTOR, auditEvent: 'check.swept', emailPath: 'automatic re-check', requireFailed: true,
    })

    expect(res.status).toBe('duplicate')
    const row = fake.tables.guardian_checks.find((r: any) => r.id === 'chk-failed')!
    expect(row.is_duplicate).toBe(true)
    expect(row.duplicate_of_id).toBe('chk-earlier-classified')
    expect(row.classification_failed).toBe(false)
  })
})
