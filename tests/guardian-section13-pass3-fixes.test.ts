// tests/guardian-section13-pass3-fixes.test.ts
//
// Regression guards for Guardian / scope governance, independent pass 3:
//   B1 — dedup embedded only the first 500 chars, so a re-pasted thread with a new request appended was a "duplicate"
//   B2 — an accepted CO never cleared the same title from the snapshot's out_of_scope list (contradictory verdicts)
//   B3 — a retroactive check on a Complete/Archived project raised a live open flag and emailed the team

import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createFakeSupabase } from './helpers/fake-supabase'

vi.mock('@/lib/ai/guardian', async (orig) => {
  const actual: any = await orig()
  return {
    ...actual,
    classifyGuardianCheck: vi.fn(async () => ({
      outcome: 'out_of_scope', matchConfidence: 0.1, creepConfidence: 0.95,
      matchedAgainst: null, matchedReference: 'Deliverable A', reasoning: 'Beyond the agreed scope.',
    })),
  }
})

import { embeddingText, EMBED_TEXT_MAX, classifyAndRecord, GUARDIAN_SYSTEM_ACTOR } from '@/lib/ai/guardian-pipeline'

const root = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

describe('B1 — the dedup embedding covers the whole submission, including text appended at the end', () => {
  const thread = Array.from({ length: 12 }, (_, i) => `Client (10:0${i % 10}): message ${i} about the homepage copy and colours we discussed earlier`).join('\n')

  it('a short message is embedded exactly as written', () => {
    expect(embeddingText('Please add dark mode')).toBe('Please add dark mode')
  })

  it('a re-pasted thread with a NEW request appended no longer embeds identically to the original', () => {
    const grown = `${thread}\nClient (11:30): Also add a full Spanish translation and a mobile app.`
    expect(thread.length).toBeGreaterThan(500)
    expect(embeddingText(grown)).not.toBe(embeddingText(thread))
  })

  it('a very long submission stays within the embedding budget and keeps both its start and its end', () => {
    const long = `START-MARK ${'lorem ipsum '.repeat(1000)} END-MARK`
    const t = embeddingText(long)
    expect(t.length).toBeLessThanOrEqual(EMBED_TEXT_MAX)
    expect(t).toContain('START-MARK')
    expect(t).toContain('END-MARK')
  })
})

describe('B3 — recordOnly records the verdict but raises no flag and notifies nobody', () => {
  const base = (extra: Record<string, unknown> = {}) => ({
    check: { id: 'chk1', content: 'Please also build a mobile app' },
    project: { id: 'p1', name: 'Acme', workspace_id: 'w1' },
    snapshot: { deliverables: [{ title: 'Website' }], out_of_scope: [] },
    sensitivity: 'medium' as const,
    actor: GUARDIAN_SYSTEM_ACTOR, auditEvent: 'check.classified', emailPath: 'paste',
    ...extra,
  })
  const seed = () => createFakeSupabase({
    guardian_checks: [{ id: 'chk1', project_id: 'p1', workspace_id: 'w1', outcome: 'pending', flag_id: null, classification_failed: false }],
    guardian_flags: [], amendments: [],
  })

  it('recordOnly: verdict stored, no flag row, flagId null', async () => {
    const fake = seed()
    const res = await classifyAndRecord(fake.client as any, base({ recordOnly: true }))
    expect(res.status).toBe('classified')
    expect((res as any).flagId).toBeNull()
    expect(fake.tables.guardian_flags).toHaveLength(0)
    const check = fake.tables.guardian_checks.find((r: any) => r.id === 'chk1')!
    expect(check.outcome).toBe('out_of_scope')
    expect(check.flag_id).toBeNull()
  })

  it('without recordOnly the flag is still raised (live path unchanged)', async () => {
    const fake = seed()
    const res = await classifyAndRecord(fake.client as any, base())
    expect(fake.tables.guardian_flags).toHaveLength(1)
    expect((res as any).flagId).toBe(fake.tables.guardian_flags[0].id)
  })

  it('the check route only suppresses the flag for a terminal project', () => {
    const src = read('app/api/guardian/check/route.ts')
    expect(src).toMatch(/recordOnly: isTerminalStatus\(project\.status\)/)
    expect(src).toMatch(/flagSuppressed/)
  })
})

describe('B2 — migration 128 + classifier rule keep excluded and CO-added titles consistent', () => {
  const sql = read('supabase/migrations/128_guardian_co_clears_exclusions.sql')

  it('append_scope_deliverables clears matching out_of_scope entries and skips titles already present', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.append_scope_deliverables/)
    expect(sql).toMatch(/out_of_scope = ARRAY\(/)
    expect(sql).toMatch(/NOT IN \(/)
    expect(sql).toMatch(/NOT EXISTS \(/)
    expect(sql).toMatch(/version\s+= COALESCE\(s\.version, 1\) \+ 1/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.append_scope_deliverables\(uuid, jsonb, timestamptz\) TO service_role/)
  })

  it('the data repair honours the signing-after and later-removal guards', () => {
    expect(sql).toMatch(/NOT \(s\.last_updated_by = 'signing' AND s\.last_updated_at > a\.created_at\)/)
    expect(sql).toMatch(/a2\.created_at > a\.created_at/)
  })

  it('the classifier prompt tells the model an excluded item also listed under an accepted CO is covered', () => {
    const src = read('lib/ai/guardian.ts')
    expect(src).toMatch(/explicitly excluded clauses AND is also listed under ACCEPTED CHANGE ORDERS/)
  })
})
