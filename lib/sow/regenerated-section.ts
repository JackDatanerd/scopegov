// lib/sow/regenerated-section.ts
//
// Drafting a SOW does more than ask the model: the app then writes the fixed clauses itself (Termination, Dispute Resolution, the
// payment period and late-fee sentences, the portfolio-use and client-materials paragraphs, the change-order clause, the review
// window) and lower-cases an undefined "the Services". Rewriting ONE section with AI went around all of it: figures were guarded,
// but a rewrite could still reword a fixed clause, drop the change-order clause, add portfolio wording nobody chose, or bring back a
// capitalised "the Services". This applies the same rules to a regenerated section, from what the section already said.

import { stripPortfolioWording } from '@/lib/documents/standard-clauses'
import { ensureChangeOrderClause, ensureApprovalSilenceStated } from '@/lib/ai/sow-content'
import { servicesIsDefined, lowerUndefinedServices } from '@/lib/documents/defined-terms'

const isEnglish = (language: unknown) => !language || /^en\b/i.test(String(language))
const plain = (html: string) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().toLowerCase()
const paragraphs = (html: string) => String(html ?? '').match(/<p>[\s\S]*?<\/p>/gi) || []

// Paragraphs the app writes from a workspace setting. Each opens with a fixed bold lead (see standard-clauses / client-materials).
const PROTECTED_LEADS = ['portfolio use.', 'client materials.', 'supply of materials.', 'late payment.']
const PERIOD_SENTENCE_RE = /\b(?:due|payable)\s+within\s+\d{1,3}\s+(?:calendar\s+)?days?\s+(?:of|from|after)\s+(?:its|the|their|an?)?\s*invoice\s+date\b/i
const leadOf = (para: string) => PROTECTED_LEADS.find(l => plain(para).startsWith(l))

/** Sections whose English text is a fixed clause: an unprompted "improve clarity" rewrite has nothing to improve and only risks the wording. */
export function isFixedClauseSection(sectionId: string, language: unknown): boolean {
  return isEnglish(language) && (sectionId === 'termination' || sectionId === 'dispute')
}

export interface FinalizeInput {
  sectionId: string
  /** The section as it stood before the rewrite. */
  before: string
  /** The model's rewrite. */
  after: string
  language?: string | null
  metadata?: { approvalSilence?: { days?: number | null } | null } | null
  /** Text of the OTHER sections, to decide whether "the Services" is defined anywhere. */
  otherSectionsText?: string[]
}

export function finalizeRegeneratedSection(input: FinalizeInput): string {
  let out = String(input.after ?? '')
  const language = input.language
  const english = isEnglish(language)

  // 1. Paragraphs written from a workspace setting survive a rewrite word for word.
  const keep = paragraphs(input.before).filter(p => leadOf(p))
  if (keep.length) {
    if (keep.some(p => leadOf(p) === 'portfolio use.')) out = stripPortfolioWording(out)
    for (const para of keep) {
      if (plain(out).includes(plain(para))) continue
      const lead = leadOf(para)
      out = out.replace(/<p>[\s\S]*?<\/p>/gi, whole => (leadOf(whole) === lead ? '' : whole))
      out = `${out}${para}`
    }
  }

  // 2. The payment period sentence ("each invoice is due within N days of its invoice date") is a term the invoices obey.
  if (input.sectionId === 'payment') {
    const had = paragraphs(input.before).find(p => PERIOD_SENTENCE_RE.test(plain(p)) && !leadOf(p))
    if (had && !PERIOD_SENTENCE_RE.test(plain(out))) out = `${out}${had}`
  }

  if (english) {
    // 3. Out of Scope always says how an excluded item can be added.
    if (input.sectionId === 'oos' && /change[- ]orders?/i.test(plain(input.before))) out = ensureChangeOrderClause(out, { language } as any)
    // 4. A chosen client review window is stated exactly, in the Revision Policy.
    if (input.sectionId === 'revisions' && input.metadata?.approvalSilence?.days)
      out = ensureApprovalSilenceStated(out, { language, approvalSilence: input.metadata.approvalSilence } as any)
  }

  // 5. "the Services" is only capitalised where the document defines it.
  if (!servicesIsDefined([out, ...(input.otherSectionsText || [])])) out = lowerUndefinedServices(out)
  return out
}
