import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { normalizeApprovalSilence, normalizeApprovalDays, approvalSilenceSentence, DEFAULT_APPROVAL_DAYS } from '@/lib/documents/approval-silence'
import { ensureApprovalSilenceStated, approvalSilenceHtml, approvalSilencePromptBlock, type SowContentInput } from '@/lib/ai/sow-content'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const input = (approvalSilence: any, language?: string): SowContentInput => ({ approvalSilence, language } as unknown as SowContentInput)

describe('normalizing the stored rule', () => {
  it('null / unknown means the SOW says nothing', () => {
    expect(normalizeApprovalSilence(null)).toBeNull()
    expect(normalizeApprovalSilence('')).toBeNull()
    expect(normalizeApprovalSilence('tacit')).toBeNull()
    expect(normalizeApprovalSilence(undefined, undefined)).toBeNull()
  })
  it('deemed approved keeps a valid day count and falls back to 5 without one', () => {
    expect(normalizeApprovalSilence('deemed_approved', 3)).toEqual({ mode: 'deemed_approved', days: 3 })
    expect(normalizeApprovalSilence('deemed_approved', null)).toEqual({ mode: 'deemed_approved', days: DEFAULT_APPROVAL_DAYS })
    expect(normalizeApprovalSilence('deemed_approved', 99)).toEqual({ mode: 'deemed_approved', days: DEFAULT_APPROVAL_DAYS })
    expect(normalizeApprovalDays('')).toBeNull()
    expect(normalizeApprovalDays(0)).toBeNull()
    expect(normalizeApprovalDays(30)).toBe(30)
  })
  it('work waits keeps the window when one is set', () => {
    expect(normalizeApprovalSilence('work_waits', 7)).toEqual({ mode: 'work_waits', days: 7 })
    expect(normalizeApprovalSilence('work_waits', null)).toEqual({ mode: 'work_waits', days: null })
  })
  it('a review window alone is a valid rule (no consequence stated)', () => {
    expect(normalizeApprovalSilence('', 3)).toEqual({ mode: null, days: 3 })
    expect(normalizeApprovalSilence(null, 3)).toEqual({ mode: null, days: 3 })
    expect(normalizeApprovalSilence(null, 0)).toBeNull()
  })
})

describe('the fixed clause', () => {
  it('states the day count, singular and plural', () => {
    expect(approvalSilenceSentence({ mode: 'deemed_approved', days: 1 })).toContain('within 1 business day of')
    expect(approvalSilenceSentence({ mode: 'deemed_approved', days: 3 })).toContain('within 3 business days of')
    expect(approvalSilenceSentence({ mode: 'work_waits', days: null })).toContain('will not proceed')
    expect(approvalSilenceSentence({ mode: null, days: 2 })).toBe('The Client will approve or request changes to each deliverable within 2 business days of the Provider submitting it for review.')
    expect(approvalSilenceSentence({ mode: 'deemed_approved', days: 2 })).toContain('If the Client does neither within that period')
  })
  it('is appended to Revision Policy once, only when chosen, English only', () => {
    const rule = { mode: 'deemed_approved', days: 2 }
    const out = ensureApprovalSilenceStated('<p>One revision round.</p>', input(rule))
    expect(out).toContain('<strong>Client review.</strong>')
    expect(ensureApprovalSilenceStated(out, input(rule))).toBe(out)
    expect(ensureApprovalSilenceStated('<p>x</p>', input(null))).toBe('<p>x</p>')
    expect(approvalSilenceHtml(input(rule, 'es'))).toBe('')
  })
})

describe('drafting prompt', () => {
  it('always forbids the model from writing a silence rule', () => {
    expect(approvalSilencePromptBlock(input(null))).toContain('Never state what happens when the Client does not respond')
  })
  it('English: the app states the window itself, so the model is told not to state one', () => {
    const p = approvalSilencePromptBlock(input({ mode: 'deemed_approved', days: 2 }))
    expect(p).toContain('Do NOT state a review, feedback or approval window anywhere yourself')
    expect(p).not.toContain('exactly')
    expect(approvalSilencePromptBlock(input({ mode: null, days: 4 }))).toContain('Do NOT state a review, feedback or approval window')
  })
  it('other languages (no app paragraph is appended) pin any window the model writes to the chosen day count', () => {
    expect(approvalSilencePromptBlock(input({ mode: 'deemed_approved', days: 2 }, 'fr'))).toContain('exactly 2 business days')
    expect(approvalSilencePromptBlock(input({ mode: null, days: 4 }, 'es'))).toContain('exactly 4 business days')
    expect(approvalSilencePromptBlock(input({ mode: 'work_waits', days: null }))).not.toContain('exactly')
  })
  it('with no window set, the model must not invent one or leave an undefined "agreed" window', () => {
    const p = approvalSilencePromptBlock(input(null))
    expect(p).toContain('No standard review window is set')
    expect(p).toContain('agreed in writing before work begins')
    expect(p).toContain('never invent a number of days')
  })
})

describe('wiring', () => {
  it('has a migration with value and range checks', () => {
    const sql = read('supabase/migrations/160_default_approval_silence.sql')
    expect(sql).toContain("IN ('deemed_approved', 'work_waits')")
    expect(sql).toContain('BETWEEN 1 AND 30')
  })
  it('is read at generation, frozen in metadata, and added to Revision Policy', () => {
    const g = read('app/api/sow/generate/route.ts')
    expect(g).toContain("default_approval_silence, default_approval_days")
    expect(g).toContain('ensureApprovalSilenceStated(allContent.revisions')
    expect(g).toContain('...(approvalSilence ? { approvalSilence } : {})')
  })
  it('is validated by the settings API and offered in Settings with "Don\u2019t state it" first', () => {
    const r = read('app/api/workspace/settings/route.ts')
    expect(r).toContain("defaultApprovalSilence:     'default_approval_silence'")
    expect(r).toContain("Choose a listed review option, or none")
    const c = read('components/settings/SettingsClient.tsx')
    expect(c).toContain('Don&apos;t state it')
    expect(c).toMatch(/defaultApprovalSilence:\s+ws\?\.default_approval_silence \|\| ''/)
  })
})

describe('other hints', () => {
  it('nudges for a delivery date on a one-time change order on an open-ended retainer', () => {
    expect(read('components/co/CoEditor.tsx')).toContain("won&apos;t say when the work is due")
  })
  it('tells people where the project name is printed', () => {
    expect(read('app/(app)/projects/new/page.tsx')).toContain('printed on the SOW, change orders and invoices your client receives')
    expect(read('components/projects/EditProjectModal.tsx')).toContain('printed on the SOW, change orders and invoices your client receives')
  })
})

describe('the review window is never printed twice (regression: SOW-0014 section 9)', () => {
  const rule = { mode: 'deemed_approved', days: 5 }
  const modelText = '<p>The fees include 2 revision rounds across the deliverables.</p>'
    + '<p>The Client will provide feedback or approval within 5 business days of each review request.</p>'
    + '<p>Any work beyond the included 2 revision rounds requires a written change order signed by both parties before it begins.</p>'

  it('drops the model\'s own statement of the same window and keeps everything else', () => {
    const out = ensureApprovalSilenceStated(modelText, input(rule))
    expect(out.match(/5 business days/g)).toHaveLength(1)
    expect(out).toContain('Client review.')
    expect(out).toContain('within 5 business days of the Provider submitting it for review')
    expect(out).toContain('The fees include 2 revision rounds')
    expect(out).toContain('requires a written change order')
    expect(out).not.toContain('feedback or approval within 5 business days of each review request')
  })
  it('removes only the matching sentence of a mixed paragraph', () => {
    const mixed = '<p>Two rounds are included. The Client gives feedback within 5 business days of each request. Further rounds are billed separately.</p>'
    const out = ensureApprovalSilenceStated(mixed, input(rule))
    expect(out).toContain('Two rounds are included. Further rounds are billed separately.')
    expect(out.match(/5 business days/g)).toHaveLength(1)
  })
  it('leaves a different number of days, and sentences not about review, untouched', () => {
    const other = '<p>Invoices are due within 5 business days. Deliverables are reviewed within 3 business days.</p>'
    expect(ensureApprovalSilenceStated(other, input(rule)).startsWith(other)).toBe(true)
  })
  it('does nothing when no rule is chosen, and is idempotent', () => {
    expect(ensureApprovalSilenceStated(modelText, input(null))).toBe(modelText)
    const once = ensureApprovalSilenceStated(modelText, input(rule))
    expect(ensureApprovalSilenceStated(once, input(rule))).toBe(once)
  })
  it('a window-only rule (no consequence) is deduplicated the same way', () => {
    const out = ensureApprovalSilenceStated(modelText, input({ mode: null, days: 5 }))
    expect(out.match(/5 business days/g)).toHaveLength(1)
  })
})

