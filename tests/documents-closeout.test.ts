import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { pickAgencyStandards } from '@/lib/utils/agency-standards'
import { parseWorkType, isWorkType, WORK_TYPES } from '@/lib/utils/project-input'
import { excludedActivities, unstatedExclusions, ensureAddedExclusionsStated } from '@/lib/documents/co-draft-text'
import { deliveryDateFromDays, deliveryDateWarning, DELIVERY_DATE_WARNING } from '@/lib/documents/co-delivery'

const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

const INFLUENCER = 'One-time fee for researching, vetting and delivering a single shortlist of up to 15 influencer or creator candidates suited to the Client\u2019s brand, each with a short fit summary. The fee covers the full shortlist of up to 15 candidates whether or not all are used; it does not include outreach, negotiation, contracting or management'
const AFFILIATE = 'One-time fee for researching, vetting and delivering a single shortlist of up to 10 affiliate partner candidates suited to the Client\u2019s brand, each with a short fit summary. The fee covers the full shortlist of up to 10 candidates whether or not all are used; it does not include outreach, negotiation, contracting or program management'
const LINES = [{ description: INFLUENCER }, { description: AFFILIATE }]
const NOTE = 'This work falls under the "Out of Scope" section: identifying influencers is named in the "Influencer partnerships" exclusion, and this change order amends that exclusion for identifying influencers only, while negotiating with, contracting and managing influencers or creators remain excluded. Identifying affiliate partners is additional work.'

describe('retainer kind of work (migration 162)', () => {
  const rows = [
    { project_type: null, revision_policy: 'Global policy', payment_terms: null, out_of_scope_clauses: ['global clause'], assumptions: null },
    { project_type: 'marketing', revision_policy: null, payment_terms: null, out_of_scope_clauses: ['marketing clause'], assumptions: null },
    { project_type: 'retainer', revision_policy: 'Retainer policy', payment_terms: null, out_of_scope_clauses: null, assumptions: null },
  ]
  it('a Marketing retainer keeps the Marketing standards; the retainer row still wins field by field', () => {
    const s = pickAgencyStandards(rows, 'retainer', 'marketing')
    expect(s?.outOfScopeClauses).toEqual(['marketing clause'])
    expect(s?.revisionPolicy).toBe('Retainer policy')
  })
  it('without a kind of work the answer is what it was before', () => {
    const s = pickAgencyStandards(rows, 'retainer')
    expect(s?.outOfScopeClauses).toEqual(['global clause'])
    expect(pickAgencyStandards(rows, 'retainer', null)).toEqual(s)
    expect(pickAgencyStandards(rows, 'web')?.revisionPolicy).toBe('Global policy')
  })
  it('a deliberately blank override is still honoured, not refilled from a lower layer', () => {
    const blank = [...rows.slice(0, 1), { project_type: 'marketing', revision_policy: null, payment_terms: null, out_of_scope_clauses: [], assumptions: null }]
    expect(pickAgencyStandards(blank, 'retainer', 'marketing')?.outOfScopeClauses).toEqual([])
  })
  it('only a real kind of work is accepted, and retainer is not one', () => {
    expect(parseWorkType('marketing')).toEqual({ ok: true, value: 'marketing' })
    expect(parseWorkType('')).toEqual({ ok: true, value: null })
    expect(parseWorkType(null)).toEqual({ ok: true, value: null })
    expect(parseWorkType('retainer').ok).toBe(false)
    expect(parseWorkType('nonsense').ok).toBe(false)
    expect(isWorkType('video')).toBe(true)
    expect(WORK_TYPES).not.toContain('retainer')
  })
  it('is wired through create, update, SOW generation and the schema', () => {
    expect(src('app/api/projects/route.ts')).toContain('work_type:      workType')
    const patch = src('app/api/projects/[id]/route.ts')
    expect(patch).toContain('updates.work_type')
    expect(patch).toContain("isWorkType(project.type) ? project.type : null")
    expect(src('app/api/sow/generate/route.ts')).toContain('project.type, project.work_type')
    expect(src('supabase/migrations/162_project_work_type.sql')).toContain("type = 'retainer'")
  })
})

describe('change order exclusions are stated in the Impact Analysis', () => {
  it('reads what each line says it does not include', () => {
    expect(excludedActivities(LINES)).toEqual(['outreach', 'negotiation', 'contracting', 'management', 'program management'])
  })
  it('finds the activity the scope note leaves out', () => {
    expect(unstatedExclusions(NOTE, LINES)).toEqual(['outreach'])
  })
  it('appends one sentence for it, and nothing when the note already covers everything', () => {
    const out = ensureAddedExclusionsStated(NOTE, LINES)!
    expect(out.startsWith(NOTE)).toBe(true)
    expect(out.endsWith(' The added work does not include outreach.')).toBe(true)
    expect(ensureAddedExclusionsStated(out, LINES)).toBe(out)
    expect(ensureAddedExclusionsStated(NOTE, [{ description: 'Two logo rounds' }])).toBe(NOTE)
    expect(ensureAddedExclusionsStated(null, LINES)).toBeNull()
  })
  it('adds a missing full stop before the sentence', () => {
    expect(ensureAddedExclusionsStated('Additional work', [{ description: 'A shortlist. It does not include outreach' }])).toBe('Additional work. The added work does not include outreach.')
  })
  it('the drafter and the send route both use it', () => {
    expect(src('app/api/co/draft/route.ts')).toContain('ensureAddedExclusionsStated(')
    expect(src('app/api/co/[id]/send/route.ts')).toContain('unstatedExclusions(co.scope_impact_note')
  })
})

describe('delivery date on one-time work on a retainer', () => {
  const open = { type: 'retainer', retainer_duration_months: null }
  it('turns a number of days into a calendar date, and refuses anything unusable', () => {
    const from = new Date('2026-10-16T22:30:00Z')
    expect(deliveryDateFromDays(10, from)).toBe('2026-10-26')
    expect(deliveryDateFromDays('7', from)).toBe('2026-10-23')
    for (const bad of [0, -3, 1.5, 121, null, undefined, '', 'soon', NaN]) expect(deliveryDateFromDays(bad as any, from)).toBeNull()
  })
  it('warns only for a charged, one-time change order on an open-ended retainer with no date', () => {
    const co = { total: 600, is_retainer_renewal: false, is_credit: false, revised_delivery_date: null }
    expect(deliveryDateWarning(co, open)).toBe(DELIVERY_DATE_WARNING)
    expect(deliveryDateWarning({ ...co, revised_delivery_date: '2026-10-26' }, open)).toBeNull()
    expect(deliveryDateWarning({ ...co, is_retainer_renewal: true }, open)).toBeNull()
    expect(deliveryDateWarning({ ...co, is_credit: true }, open)).toBeNull()
    expect(deliveryDateWarning({ ...co, total: 0 }, open)).toBeNull()
    expect(deliveryDateWarning(co, { type: 'retainer', retainer_duration_months: 12 })).toBeNull()
    expect(deliveryDateWarning(co, { type: 'web', retainer_duration_months: null })).toBeNull()
  })
  it('is wired into the drafter, the send route and the editor', () => {
    expect(src('app/api/co/draft/route.ts')).toContain('deliveryDateFromDays(parsed.deliveryDays)')
    expect(src('app/api/co/[id]/send/route.ts')).toContain('deliveryDateWarning(co, co.projects)')
    expect(src('components/co/CoEditor.tsx')).toContain('json.documentWarnings?.length')
  })
})
