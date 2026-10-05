// Section 13 (Guardian / scope governance) — independent pass 14 fixes.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { interpretClassifierOutput } from '@/lib/ai/guardian'
import { reclassifyCheck } from '@/lib/ai/guardian-pipeline'
import { extractUnquotedContent, matchGuardianAddress } from '@/lib/ai/guardian-email'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_REQUEST_BYTES } from '@/lib/utils/upload-limits'

const read = (p: string) => readFileSync(p, 'utf-8')

describe('B1: upload cap is below the platform request-body limit', () => {
  it('is under Vercel\'s 4.5 MB even with multipart framing', () => {
    expect(MAX_UPLOAD_BYTES).toBeLessThan(4.5 * 1024 * 1024)
    expect(MAX_UPLOAD_REQUEST_BYTES).toBeLessThan(4.5 * 1024 * 1024)
  })
  it('every attachment route and editor uses the shared cap, none still advertises 10 MB', () => {
    for (const p of [
      'app/api/scope-governance/[entityType]/[entityId]/attachments/route.ts',
      'app/api/sow/[id]/attachments/route.ts', 'app/api/co/[id]/attachments/route.ts',
      'components/sow/SowEditor.tsx', 'components/co/CoEditor.tsx', 'components/projects/FlagCollaboration.tsx',
    ]) {
      const src = read(p)
      expect(src).not.toMatch(/10 MB/)
      expect(src).not.toMatch(/10 \* 1024 \* 1024/)
    }
  })
})

describe('B2: a verdict without reasoning still gets a description', () => {
  const o = { autoFlag: 0.85, borderlineMin: 0.6, hasAmendments: true }
  it('falls back when reasoning is missing, null or blank', () => {
    for (const r of ['', ',"reasoning":null', ',"reasoning":"   "']) {
      const raw = `{"matchConfidence":0.1,"creepConfidence":0.95,"matchedAgainst":null,"matchedReference":null${r === '' ? '' : r}}`
      const res = interpretClassifierOutput(raw, o)
      expect(res.outcome).toBe('out_of_scope')
      expect(res.reasoning.length).toBeGreaterThan(10)
    }
  })
  it('keeps the model\'s own reasoning when present', () => {
    const res = interpretClassifierOutput('{"matchConfidence":0.1,"creepConfidence":0.95,"reasoning":"Asks for a mobile app."}', o)
    expect(res.reasoning).toBe('Asks for a mobile app.')
  })
})

describe('B3/B4: retry claims its rate slot atomically; guardian AI routes bound their duration', () => {
  it('retry uses claimAiRateSlot, not check-then-record', () => {
    const src = read('app/api/guardian/checks/[id]/retry/route.ts')
    expect(src).toContain('claimAiRateSlot')
    expect(src).not.toContain('checkAiRateLimit')
    expect(src).not.toContain('recordAiUsage(')
  })
  it('check / inbound / retry export maxDuration and the SDK clients have a timeout', () => {
    for (const p of ['app/api/guardian/check/route.ts', 'app/api/guardian/inbound/route.ts', 'app/api/guardian/checks/[id]/retry/route.ts'])
      expect(read(p)).toMatch(/export const maxDuration = 120/)
    expect(read('lib/ai/guardian.ts')).toMatch(/timeout: AI_CALL_TIMEOUT_MS, maxRetries: 1/g)
  })
})

describe('B5: email parsing', () => {
  it('a bare "--" followed by more request text is a separator, not a signature', () => {
    expect(extractUnquotedContent('Please add dark mode.\n--\nAlso add Spanish.')).toBe('Please add dark mode.\nAlso add Spanish.')
  })
  it('the real "-- " delimiter, and a bare "--" before a signature, still end the message', () => {
    expect(extractUnquotedContent('Add SSO.\n-- \nJane\nAcme')).toBe('Add SSO.')
    expect(extractUnquotedContent('Add SSO.\n--\nJane\nAcme')).toBe('Add SSO.')
  })
  it('cuts localized attributions and Outlook headers', () => {
    expect(extractUnquotedContent('Bitte Dark Mode.\n\nAm 01.09.2026 um 10:00 schrieb Bob <bob@x.com>:\n> alt')).toBe('Bitte Dark Mode.')
    expect(extractUnquotedContent('Merci.\n\nLe 1 sept. 2026 à 10:00, Bob <bob@x.com> a écrit :\nvieux')).toBe('Merci.')
    expect(extractUnquotedContent('Añadir modo oscuro.\n\nEl lun, 1 sept 2026 a las 10:00, Bob <bob@x.com> escribió:\nviejo')).toBe('Añadir modo oscuro.')
    expect(extractUnquotedContent('Bitte Blog.\n\nVon: Bob <b@x.com>\nGesendet: Montag\nAn: Uns\nBetreff: x\n\nalter text')).toBe('Bitte Blog.')
    expect(extractUnquotedContent('Un blog.\n\nDe : Bob <b@x.com>\nEnvoyé : lundi\nÀ : Nous\nObjet : x\n\nvieux')).toBe('Un blog.')
  })
  it('does not cut an ordinary sentence that starts with "On"/"Le"', () => {
    expect(extractUnquotedContent('On the homepage we need a banner.\nLe plus important: speed.')).toBe('On the homepage we need a banner.\nLe plus important: speed.')
  })
  it('accepts a plus-tagged project address', () => {
    expect(matchGuardianAddress('proj-ab12cd34+tag@guard.scopegov.app', 'guard.scopegov.app')).toBe('ab12cd34')
    expect(matchGuardianAddress('proj-ab12cd34@guard.scopegov.app.evil.com', 'guard.scopegov.app')).toBeNull()
  })
})

describe('B7: per-flag caps', () => {
  it('attachments and comments are bounded per entity', () => {
    expect(read('app/api/scope-governance/[entityType]/[entityId]/attachments/route.ts')).toContain('MAX_ATTACHMENTS_PER_ENTITY')
    expect(read('app/api/scope-governance/[entityType]/[entityId]/comments/route.ts')).toContain('MAX_COMMENTS_PER_ENTITY')
  })
})

describe('B8: a person can retry a failed check on a finished project (record only)', () => {
  function svc(status: string) {
    const check = { id: 'c1', project_id: 'p1', workspace_id: 'w1', content: 'x', is_duplicate: false, outcome: 'pending',
      classification_failed: true, classification_attempts: 1, source: 'paste', source_metadata: null, embedding: null }
    const project = { id: 'p1', name: 'P', status, stall_reason: null, deleted_at: null, workspace_id: 'w1',
      workspaces: { id: 'w1', guardian_sensitivity_tier: 'medium', deleted_at: null },
      project_scope_snapshot: { deliverables: [], out_of_scope: [], last_updated_at: null } }
    const mk = (row: any) => { const c: any = {}; for (const m of ['select', 'eq']) c[m] = vi.fn(() => c); c.maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null }); return c }
    const claim: any = {}; for (const m of ['update', 'eq']) claim[m] = vi.fn(() => claim); claim.select = vi.fn().mockResolvedValue({ data: [], error: null })
    return { from: vi.fn((t: string) => (t === 'guardian_checks' ? { ...mk(check), update: claim.update } : mk(project))) }
  }
  const base = { actor: { id: 'u1', email: 'a@b.c', name: 'A' }, auditEvent: 'check.retried', emailPath: 'retry', requireFailed: true }
  it('is refused by default (the sweep) and by Retry before this fix', async () => {
    const r = await reclassifyCheck(svc('Complete') as any, 'c1', base)
    expect(r).toEqual({ status: 'skipped', reason: 'inactive' })
  })
  it('gets past the inactive gate when a person asks, but never for a deleted workspace', async () => {
    const r = await reclassifyCheck(svc('Archived') as any, 'c1', { ...base, allowFinishedProject: true })
    expect(r).toEqual({ status: 'skipped', reason: 'claimed' }) // reached the attempt claim
  })
  it('the sweep never passes the option', () => {
    expect(read('app/api/cron/guardian-health/route.ts')).not.toContain('allowFinishedProject')
    expect(read('app/api/guardian/checks/[id]/retry/route.ts')).toContain('allowFinishedProject: true')
  })
})

describe('B9: stranded converted_to_co flags are repaired by guardian-health', () => {
  it('the cron links a flag to its CO or reopens it, with a compare-and-swap on the stuck state', () => {
    const src = read('app/api/cron/guardian-health/route.ts')
    expect(src).toContain('healStrandedFlags')
    expect(src).toMatch(/\.eq\('status', 'converted_to_co'\)\.is\('change_order_id', null\)\.select\('id'\)/)
    expect(src).toContain("status: 'open'")
  })
})
