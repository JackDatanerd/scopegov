import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseDelimitedSections, parseTableSections, AI_SECTION_IDS } from '@/lib/ai/sow-content'
import { sanitizeRichText } from '@/lib/utils/sanitize'
import { sanitizeSectionList } from '@/lib/sow/sections'
import { parseTableAmount } from '@/lib/sow/table-schema'

// ── B1: model output that is cut off / has trailing text must never become contract text ────────────────────────
const PROSE = AI_SECTION_IDS.map(id => `<<<SECTION:${id}>>>\n<p>Content for ${id} section text.</p>`).join('\n')
const DELIVERABLES = '<<<TABLE:deliverables>>>\nWebsite | Approved by client | Provider | Sep 1\n<<<ENDTABLE>>>'
const TIMELINE = '<<<TABLE:timeline>>>\nPhase 1 | Build | 2 weeks\n<<<ENDTABLE>>>'
const ROLES = '<<<TABLE:roles>>>\nDesign | ✓ | — | note\n<<<ENDTABLE>>>'
const SCHEDULE = '<<<TABLE:payment_schedule>>>\nKickoff | 0 | Upon signing\nFinal | 0 | Upon delivery\n<<<ENDTABLE>>>'
const ALL_TABLES = [DELIVERABLES, TIMELINE, ROLES, SCHEDULE].join('\n')
const EXPECTED_DISPUTE = '<p>Content for dispute section text.</p>'

describe('B1 — parseDelimitedSections keeps non-section text out of the last prose section', () => {
  it('a well-formed reply is unchanged', () => {
    const s = parseDelimitedSections(`${PROSE}\n${ALL_TABLES}`)
    expect(s.dispute).toBe(EXPECTED_DISPUTE)
    expect(s.overview).toBe('<p>Content for overview section text.</p>')
  })
  it('an unterminated LAST table (cut off / forgotten ENDTABLE) does not leak into Dispute Resolution', () => {
    const raw = `${PROSE}\n${DELIVERABLES}\n<<<TABLE:payment_schedule>>>\nKickoff | 0 | Upon sign\nMid | 0 | Upon deliv`
    const s = parseDelimitedSections(raw)
    expect(s.dispute).toBe(EXPECTED_DISPUTE)
    expect(sanitizeRichText(s.dispute)).not.toMatch(/&lt;|Kickoff|TABLE/)
  })
  it('a trailing code fence and closing commentary after the tables are dropped', () => {
    const s = parseDelimitedSections(`${PROSE}\n${ALL_TABLES}\nLet me know if you would like any changes!\n\`\`\``)
    expect(s.dispute).toBe(EXPECTED_DISPUTE)
  })
  it('a wrapping ```html fence does not reach the first or last section', () => {
    const s = parseDelimitedSections(`\`\`\`html\n${PROSE}\n${ALL_TABLES}\n\`\`\``)
    expect(s.overview).toBe('<p>Content for overview section text.</p>')
    expect(s.dispute).toBe(EXPECTED_DISPUTE)
  })
  it('a table missing its ENDTABLE that is followed by another table is cut at that next marker', () => {
    const raw = `${PROSE}\n<<<TABLE:deliverables>>>\nWebsite | OK | Provider | Sep 1\n${TIMELINE}\n${ROLES}`
    expect(parseDelimitedSections(raw).dispute).toBe(EXPECTED_DISPUTE)
    const t = parseTableSections(raw)
    expect(t.deliverables).toHaveLength(1)
    expect(t.deliverables[0].deliverable).toBe('Website')
    expect(t.timeline).toHaveLength(1)
  })
  it('prose before a mid-document table is kept, text after the table within that section is not', () => {
    const raw = `<<<SECTION:overview>>>\n<p>Overview text here ok</p>\n${DELIVERABLES}\nstray words\n` +
      PROSE.split('\n').slice(2).join('\n')
    const s = parseDelimitedSections(raw)
    expect(s.overview).toBe('<p>Overview text here ok</p>')
  })
  it('a section genuinely missing still fails the parse', () => {
    expect(() => parseDelimitedSections(`${DELIVERABLES}`)).toThrow()
  })
})

describe('B1 — parseTableSections', () => {
  it('a table that runs to the very end of the output (maybe cut mid-row) is not used', () => {
    const t = parseTableSections(`${PROSE}\n${DELIVERABLES}\n<<<TABLE:payment_schedule>>>\nKickoff | 0 | Upon sign\nMid | 0 | Upon deli`)
    expect(t.deliverables).toHaveLength(1)
    expect(t.payment_schedule).toEqual([])
  })
  it('well-formed tables still parse', () => {
    const t = parseTableSections(`${PROSE}\n${ALL_TABLES}`)
    expect(t.payment_schedule).toHaveLength(2)
    expect(t.roles[0].provider).toBe('✓')
  })
})

// ── B2: whole-list write with partial section objects ────────────────────────────────────────────────────────────
describe('B2 — sanitizeSectionList keeps stored fields the caller did not supply', () => {
  const stored = [
    { id: 'overview', content: '<p>keep me</p>', visible: false },
    { id: 'deliverables', content: '', visible: true, table: [{ deliverable: 'Site', acceptanceCriteria: 'ok', owner: 'Provider', targetDate: 'Sep 1' }] },
  ]
  const find = (out: any[], id: string) => out.find(s => s.id === id)
  it('{ id } alone no longer blanks the text or un-hides the section', () => {
    const out = sanitizeSectionList([{ id: 'overview' }], stored, {})
    expect(find(out, 'overview').content).toBe('<p>keep me</p>')
    expect(find(out, 'overview').visible).toBe(false)
  })
  it('supplied fields still replace the stored ones', () => {
    const out = sanitizeSectionList([{ id: 'overview', content: '<p>new</p>', visible: true }], stored, {})
    expect(find(out, 'overview').content).toBe('<p>new</p>')
    expect(find(out, 'overview').visible).toBe(true)
  })
  it('an explicit empty string still clears the content', () => {
    expect(find(sanitizeSectionList([{ id: 'overview', content: '' }], stored, {}), 'overview').content).toBe('')
  })
  it('a missing / non-array table keeps the stored rows; a supplied array replaces them', () => {
    expect(find(sanitizeSectionList([{ id: 'deliverables' }], stored, {}), 'deliverables').table[0].deliverable).toBe('Site')
    expect(find(sanitizeSectionList([{ id: 'deliverables', table: 'x' }], stored, {}), 'deliverables').table[0].deliverable).toBe('Site')
    expect(find(sanitizeSectionList([{ id: 'deliverables', table: [] }], stored, {}), 'deliverables').table).toEqual([])
  })
  it('required sections stay visible and legacy payment_schedule keeps its structure-derived default', () => {
    const out = sanitizeSectionList([{ id: 'oos', visible: false }], [], { paymentStructure: '50_50' })
    expect(find(out, 'oos').visible).toBe(true)
    expect(find(out, 'payment_schedule').visible).toBe(false)
    expect(find(sanitizeSectionList([], [], { paymentStructure: 'milestones' }), 'payment_schedule').visible).toBe(true)
  })
})

// ── B3: parentheses ──────────────────────────────────────────────────────────────────────────────────────────────
describe('B3 — parseTableAmount only reads a number as a negative when IT is the parenthesised part', () => {
  it('accounting negatives still work', () => {
    expect(parseTableAmount('(500)')).toBe(-500)
    expect(parseTableAmount('($1,500.00)')).toBe(-1500)
    expect(parseTableAmount('( USD 200 )')).toBe(-200)
    expect(parseTableAmount('Credit (500)')).toBe(-500)
    expect(parseTableAmount('Credit (refund) (500)')).toBe(-500)
  })
  it('a label with its own closed parentheses is not a negative', () => {
    expect(parseTableAmount('Deposit (due) 500 (net)')).toBe(500)
    expect(parseTableAmount('(approx) 500 (USD)')).toBe(500)
    expect(parseTableAmount('500 (credit)')).toBe(500)
    expect(parseTableAmount('1,500')).toBe(1500)
  })
})

// ── B4: withdraw keeps 'Changes Requested' while a draft carrying the change request is open ──────────────────────
const h = vi.hoisted(() => ({
  sowStatus: 'changes_requested', drafts: [] as any[], projectStatusUpdates: [] as any[],
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'a@b.co', name: 'A', workspaceId: 'w1', emailVerifiedAt: '2026-01-01', permissions: ['SEND_SOW'] }),
  hasPermission: (s: any, p: string) => (s?.permissions || []).includes(p),
}))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: async () => true }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/email/templates', () => ({ sendDocumentCancelledEmail: async () => ({}) }))
vi.mock('@/lib/email/reply-to', () => ({ resolveReplyTo: async () => null }))
vi.mock('@/lib/utils/client-contacts', () => ({ withPrimaryContactCc: async () => [] }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q: any = { table, mode: 'select', filters: {}, ins: {} }
      const b: any = {
        select: () => b, limit: () => b, order: () => b,
        update: (p: any) => { q.mode = 'update'; q.payload = p; return b },
        insert: () => { q.mode = 'insert'; return b },
        eq: (k: string, v: any) => { q.filters[k] = v; return b },
        neq: () => b,
        in: (k: string, v: any) => { q.ins[k] = v; return b },
        single: async () => ({
          data: { id: 'a1111111-1111-4111-8111-111111111111', status: h.sowStatus, token: null, version: 1, project_id: 'p1',
            projects: { id: 'p1', name: 'Proj', status: 'Changes Requested', client_id: 'c1', clients: { name: 'C', email: null, cc_emails: [] }, workspaces: { agency_name: 'A', brand_colour: null } } },
          error: null,
        }),
        maybeSingle: async () => ({
          data: { id: 'a1111111-1111-4111-8111-111111111111', status: h.sowStatus, token: null, version: 1, project_id: 'p1',
            projects: { id: 'p1', name: 'Proj', status: 'Changes Requested', client_id: 'c1', clients: { name: 'C', email: null, cc_emails: [] }, workspaces: { agency_name: 'A', brand_colour: null } } },
          error: null,
        }),
        then: (res: any) => {
          if (table === 'projects' && q.mode === 'update') h.projectStatusUpdates.push(q)
          if (table === 'sow_documents' && q.mode === 'update') return res({ data: [{ id: 'x' }], error: null })
          if (table === 'sow_documents' && q.filters.status === 'draft') return res({ data: h.drafts, error: null })
          return res({ data: [], error: null })
        },
      }
      return b
    },
  }),
}))

describe('B4 — withdraw does not undo "Changes Requested" while a draft is open', () => {
  beforeEach(() => { h.projectStatusUpdates.length = 0; h.drafts = []; h.sowStatus = 'changes_requested' })
  const call = async () => {
    const { POST } = await import('@/app/api/sow/[id]/withdraw/route')
    const req: any = { json: async () => ({}) }
    return POST(req, { params: Promise.resolve({ id: 'a1111111-1111-4111-8111-111111111111' }) })
  }
  const revert = () => h.projectStatusUpdates.find(q => q.payload?.status === 'Intake' && q.ins.status)
  it('with an open draft only "Awaiting Signature" is reverted', async () => {
    h.drafts = [{ id: 'd2' }]
    expect((await call()).status).toBe(200)
    expect(revert().ins.status).toEqual(['Awaiting Signature'])
  })
  it('with no open draft both statuses are reverted as before', async () => {
    expect((await call()).status).toBe(200)
    expect(revert().ins.status).toEqual(['Awaiting Signature', 'Changes Requested'])
  })
})

// ── B1 (route) / B5: source-level guards for behaviour that needs the model / the browser to exercise ─────────────
import { readFileSync } from 'fs'
describe('B1 / B5 — source guards', () => {
  const src = (p: string) => readFileSync(p, 'utf8')
  it('generate treats a max_tokens reply as a failed attempt BEFORE parsing it', () => {
    expect(src('app/api/sow/generate/route.ts'))
      .toMatch(/msg\.stop_reason === 'max_tokens'\) throw[\s\S]{0,400}aiSections = parseDelimitedSections\(raw\)/)
  })
  it('MSA reference saves run through one ordered chain', () => {
    const s = src('components/sow/SowEditor.tsx')
    expect(s).toMatch(/const msaChain = useRef<Promise<unknown>>/)
    expect(s).toMatch(/msaChain\.current\.then\(run, run\)/)
  })
})
