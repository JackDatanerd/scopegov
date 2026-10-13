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
    expect(normalizeApprovalSilence(undefined, 5)).toBeNull()
  })
  it('deemed approved keeps a valid day count and falls back to 5 without one', () => {
    expect(normalizeApprovalSilence('deemed_approved', 3)).toEqual({ mode: 'deemed_approved', days: 3 })
    expect(normalizeApprovalSilence('deemed_approved', null)).toEqual({ mode: 'deemed_approved', days: DEFAULT_APPROVAL_DAYS })
    expect(normalizeApprovalSilence('deemed_approved', 99)).toEqual({ mode: 'deemed_approved', days: DEFAULT_APPROVAL_DAYS })
    expect(normalizeApprovalDays('')).toBeNull()
    expect(normalizeApprovalDays(0)).toBeNull()
    expect(normalizeApprovalDays(30)).toBe(30)
  })
  it('work waits carries no day count', () => {
    expect(normalizeApprovalSilence('work_waits', 7)).toEqual({ mode: 'work_waits', days: null })
  })
})

describe('the fixed clause', () => {
  it('states the day count, singular and plural', () => {
    expect(approvalSilenceSentence({ mode: 'deemed_approved', days: 1 })).toContain('within 1 business day of')
    expect(approvalSilenceSentence({ mode: 'deemed_approved', days: 3 })).toContain('within 3 business days of')
    expect(approvalSilenceSentence({ mode: 'work_waits', days: null })).toContain('will not proceed')
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
  it('pins any review window the model writes to the chosen day count', () => {
    expect(approvalSilencePromptBlock(input({ mode: 'deemed_approved', days: 2 }))).toContain('exactly 2 business days')
    expect(approvalSilencePromptBlock(input({ mode: 'work_waits', days: null }))).not.toContain('exactly')
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
