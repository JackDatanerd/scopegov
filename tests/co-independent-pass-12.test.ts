import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { computeCoTotals } from '@/lib/documents/co-totals'
import { parseCoFields } from '@/lib/documents/co-input'
import { parseRenewalTerm } from '@/lib/documents/renewal-term'
import { parsePlainDecimal } from '@/lib/documents/strict-number'
import { hasVisibleText } from '@/lib/documents/visible-text'
import { renewalTermForDocument, formatRenewalTerm } from '@/lib/documents/co-renewal-term'
import { claimFlagForRevision } from '@/lib/documents/co-flag'
import { computeContentHash } from '@/lib/documents/executed-pdf'
import { truncateText, stripUnstorableText } from '@/lib/utils/sanitize'

const V1 = '11111111-1111-4111-8111-111111111111'
const read = (p: string) => readFileSync(p, 'utf8')

// ── in-memory query builder (eq / is / neq / lt / or-noop, select / insert / update / delete) ──
let db: Record<string, any[]>
let flagClaimWriteError = false
function table(name: string) {
  const filters: Array<(r: any) => boolean> = []
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
  let payload: any = null
  let single = false
  const b: any = {
    select: () => b,
    eq: (c: string, v: any) => { filters.push(r => r[c] === v); return b },
    is: (c: string, v: any) => { filters.push(r => (r[c] ?? null) === v); return b },
    neq: (c: string, v: any) => { filters.push(r => r[c] !== v); return b },
    lt: (c: string, v: any) => { filters.push(r => r[c] < v); return b },
    in: (c: string, v: any[]) => { filters.push(r => v.includes(r[c])); return b },
    or: () => b, order: () => b, limit: () => b,
    single: () => { single = true; return b },
    maybeSingle: () => { single = true; return b },
    insert: (p: any) => { op = 'insert'; payload = p; return b },
    update: (p: any) => { op = 'update'; payload = p; return b },
    delete: () => { op = 'delete'; return b },
    then: (resolve: any, reject: any) => {
      const rows = (db[name] = db[name] || [])
      let result: any
      if (op === 'insert') {
        const row = { id: `${name}-${rows.length + 1}`, ...payload }; rows.push(row); result = { data: row, error: null }
      } else if (op === 'update') {
        if (name === 'guardian_flags' && flagClaimWriteError && payload.status === 'converted_to_co') {
          result = { data: null, error: { message: 'db down' } }
        } else {
          const hit = rows.filter(r => filters.every(f => f(r))); hit.forEach(r => Object.assign(r, payload))
          result = { data: hit.map(r => ({ id: r.id })), error: null }
        }
      } else if (op === 'delete') {
        db[name] = rows.filter(r => !filters.every(f => f(r))); result = { data: null, error: null }
      } else {
        const hit = rows.filter(r => filters.every(f => f(r)))
        result = single ? { data: hit[0] ?? null, error: null } : { data: hit, error: null }
      }
      return Promise.resolve(result).then(resolve, reject)
    },
  }
  return b
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({ from: (t: string) => table(t) }) }))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', workspaceId: 'ws-1', email: 'a@b.c', name: 'A', emailVerifiedAt: 'x' }),
  hasPermission: () => true,
}))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: async () => true }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: vi.fn(async () => {}) }))
vi.mock('@/lib/approvals/engine', () => ({ approvalSendInFlight: async () => false, SEND_IN_FLIGHT_MESSAGE: 'x' }))
vi.mock('@/lib/documents/co-approval-cancel', () => ({ cancelCoApprovals: async () => ({ blockedBySend: false }) }))
vi.mock('@/lib/documents/co-version', () => ({
  insertNextCoVersion: async (_s: any, _root: string, row: any) => {
    const rows = (db.change_orders = db.change_orders || [])
    const created = { id: 'co-rev', version: 2, ...row }; rows.push(created); return { ok: true, id: created.id, version: 2 }
  },
}))
vi.mock('@/lib/email/templates', () => ({ sendDocumentCancelledEmail: vi.fn() }))
vi.mock('@/lib/email/delivery', () => ({ checkedSend: async () => ({ ok: true }) }))
vi.mock('@/lib/utils/client-contacts', () => ({ withPrimaryContactCc: async () => [] }))
vi.mock('@/lib/email/reply-to', () => ({ resolveReplyTo: async () => null }))

import { POST as createCo } from '@/app/api/co/route'
import { POST as reviseCo } from '@/app/api/co/[id]/revise/route'

beforeEach(() => {
  flagClaimWriteError = false
  db = {
    projects: [{ id: 'p1', workspace_id: 'ws-1', status: 'Active', deleted_at: null, type: 'fixed' }],
    sow_documents: [{ id: 's1', project_id: 'p1', status: 'signed' }],
    change_orders: [], guardian_flags: [],
  }
})

describe('CO-8: numeric strings are plain decimals only', () => {
  it('parsePlainDecimal accepts decimals and refuses hex / exponent / junk', () => {
    expect(parsePlainDecimal(' 12.50 ')).toBe(12.5)
    expect(parsePlainDecimal('.5')).toBe(0.5)
    expect(parsePlainDecimal('-3')).toBe(-3)
    for (const bad of ['0x10', '1e2', '0b11', 'Infinity', '12abc', '1,000', '']) expect(parsePlainDecimal(bad)).toBeNaN()
  })
  it('computeCoTotals refuses a hex quantity, an exponent rate and a hex tax rate', () => {
    expect(computeCoTotals([{ description: 'a', quantity: '0x10', rate: 5 }], 0, false).ok).toBe(false)
    expect(computeCoTotals([{ description: 'a', quantity: 1, rate: '1e2' }], 0, false).ok).toBe(false)
    expect(computeCoTotals([{ description: 'a', quantity: 1, rate: 5 }], '0x10', false).ok).toBe(false)
    const ok = computeCoTotals([{ description: 'a', quantity: '2', rate: '10.50' }], '16', false)
    expect(ok.ok && ok.totals.total).toBe(24.36)
  })
  it('timeline days and renewal term refuse hex / exponent strings', () => {
    expect(parseCoFields({ timelineImpactDays: '0x10' }).ok).toBe(false)
    expect(parseCoFields({ timelineImpactDays: '-5' })).toMatchObject({ ok: true, fields: { timelineImpactDays: -5 } })
    expect(parseRenewalTerm('0x10').ok).toBe(false)
    expect(parseRenewalTerm('1e1').ok).toBe(false)
    expect(parseRenewalTerm('12')).toEqual({ ok: true, value: 12 })
  })
})

describe('CO-3: a title must contain something visible', () => {
  it('rejects invisible-only titles and keeps real ones', () => {
    for (const t of ['\u200b\u200b', '\u2060', '\u3164', '\u2800 ', '\u0301', '\u200d'])
      expect(parseCoFields({ title: t })).toEqual({ ok: false, error: 'A change order needs a title' })
    expect(parseCoFields({ title: '\u200b Extra pages' }).ok).toBe(true)
    expect(parseCoFields({ title: '👩‍💻' }).ok).toBe(true)          // ZWJ sequence: visible emoji present
    expect(parseCoFields({ title: 'متن\u200cفارسی' }).ok).toBe(true) // ZWNJ inside real text
  })
  it('hasVisibleText is what the editor uses to enable Save / Send', () => {
    expect(hasVisibleText('\u200b')).toBe(false)
    expect(hasVisibleText('A')).toBe(true)
    const editor = read('components/co/CoEditor.tsx')
    expect(editor).toContain("import { hasVisibleText } from '@/lib/documents/visible-text'")
    expect(editor).toContain('disabled={saving || !hasVisibleText(title)}')
    expect(editor).toContain('disabled={sending || !hasVisibleText(title)}')
  })
})

describe('CO-1: a retainer renewal states its term wherever the client reads or signs it', () => {
  const retainer = { type: 'retainer', retainer_duration_months: 12 }
  it('renewalTermForDocument: only a renewal on a FIXED-term retainer states a term', () => {
    expect(renewalTermForDocument({ is_retainer_renewal: true, renewal_term_months: 6 }, retainer)).toBe(6)
    expect(renewalTermForDocument({ is_retainer_renewal: true, renewal_term_months: '6' }, retainer)).toBe(6)
    expect(renewalTermForDocument({ is_retainer_renewal: false, renewal_term_months: 6 }, retainer)).toBeNull()
    expect(renewalTermForDocument({ is_retainer_renewal: true, renewal_term_months: 6 }, { type: 'fixed', retainer_duration_months: 12 })).toBeNull()
    expect(renewalTermForDocument({ is_retainer_renewal: true, renewal_term_months: 6 }, { type: 'retainer', retainer_duration_months: null })).toBeNull()
    expect(renewalTermForDocument({ is_retainer_renewal: true, renewal_term_months: null }, retainer)).toBeNull()
    expect(renewalTermForDocument({ is_retainer_renewal: true, renewal_term_months: 6 }, null)).toBeNull()
    expect(formatRenewalTerm(1)).toBe('1 month'); expect(formatRenewalTerm(12)).toBe('12 months')
  })
  it('the term changes the content hash only for renewals that state one', () => {
    const base = { kind: 'co', coId: 'c', total: 100, isRetainerRenewal: true }
    expect(computeContentHash({ ...base, renewalTermMonths: 6 })).not.toBe(computeContentHash({ ...base, renewalTermMonths: 12 }))
    const fin = read('lib/documents/finalize-co.ts')
    expect(fin).toContain('...(isRenewal && renewalTermForDocument(co, project) ? { renewalTermMonths: renewalTermForDocument(co, project) } : {}),')
    expect(fin).toContain('renewalTermMonths:  isRenewal ? renewalTermForDocument(co, project) : null,')
  })
  it('every surface passes it on: both PDF routes, the portal payload + page, and the send email', () => {
    expect(read('app/api/pdf/co/[id]/route.ts')).toMatch(/renewal_term_months, is_credit/)
    expect(read('app/api/pdf/co/[id]/route.ts')).toContain('renewalTermMonths: isRenewalCo ? renewalTermForDocument(co, co.projects) : null')
    expect(read('app/api/portal/co/[token]/pdf/route.ts')).toContain('renewalTermMonths: isRenewalCo ? renewalTermForDocument(co, project) : null')
    const portal = read('app/api/portal/co/[token]/route.ts')
    expect(portal).toContain('is_retainer_renewal,renewal_term_months')
    expect(portal).toContain('projects(id,name,type,retainer_duration_months')
    expect(portal).toContain('renewalTermMonths:  renewalTermForDocument(co, co.projects)')
    expect(read('app/portal/co/[token]/page.tsx')).toContain('Retainer term: ')
    expect(read('lib/documents/send-co.ts')).toContain('renewalTermMonths: renewalTermForDocument(co, project)')
    expect(read('lib/email/templates.ts')).toContain('extends the retainer by <strong>')
    const pdf = read('lib/pdf/renderer.tsx')
    expect(pdf).toContain("<Text style={{ color: '#909090' }}>Retainer Term</Text>")
    expect(pdf).toContain('|| hasValueImpact || renewalTerm != null')
  })
})

describe('CO-2: a revision never carries a flag another change order owns', () => {
  it('claimFlagForRevision: claimed / already_ours / unavailable / failed', async () => {
    const svc = () => ({ from: (t: string) => table(t) })
    db.guardian_flags = [
      { id: 'f-open', status: 'open', change_order_id: null },
      { id: 'f-mine', status: 'converted_to_co', change_order_id: 'rev' },
      { id: 'f-other', status: 'converted_to_co', change_order_id: 'co-x' },
      { id: 'f-done', status: 'resolved', change_order_id: null },
    ]
    expect(await claimFlagForRevision(svc(), { flagId: 'f-open', revisionId: 'rev' })).toBe('claimed')
    expect(db.guardian_flags[0]).toMatchObject({ status: 'converted_to_co', change_order_id: 'rev' })
    expect(await claimFlagForRevision(svc(), { flagId: 'f-mine', revisionId: 'rev' })).toBe('already_ours')
    expect(await claimFlagForRevision(svc(), { flagId: 'f-other', revisionId: 'rev' })).toBe('unavailable')
    expect(db.guardian_flags[2].change_order_id).toBe('co-x')
    expect(await claimFlagForRevision(svc(), { flagId: 'f-done', revisionId: 'rev' })).toBe('unavailable')
    flagClaimWriteError = true
    db.guardian_flags.push({ id: 'f-open2', status: 'open', change_order_id: null })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await claimFlagForRevision(svc(), { flagId: 'f-open2', revisionId: 'rev' })).toBe('failed')
  })

  const declinedV1 = (flagId: string) => ({
    id: V1, workspace_id: 'ws-1', project_id: 'p1', status: 'declined', version: 1, root_co_id: null, flag_id: flagId,
    title: 'T', note: null, line_items: [], subtotal: 0, tax_rate: 0, tax_inclusive: false, total: 0, is_retainer_renewal: false,
    projects: { name: 'P', status: 'Active', client_id: 'c', clients: null, workspaces: null },
  })
  const revise = () => reviseCo({} as any, { params: Promise.resolve({ id: V1 }) } as any)

  it('detaches the revision when the flag now belongs to another change order', async () => {
    db.change_orders = [declinedV1('f1')]
    db.guardian_flags = [{ id: 'f1', status: 'converted_to_co', change_order_id: 'co-other' }]
    const res: any = await revise()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ coId: 'co-rev', flagDetached: true })
    expect(db.change_orders.find(c => c.id === 'co-rev').flag_id).toBeNull()
    expect(db.guardian_flags[0]).toMatchObject({ status: 'converted_to_co', change_order_id: 'co-other' }) // untouched
  })
  it('keeps the link and claims the flag when it is still free', async () => {
    db.change_orders = [declinedV1('f1')]
    db.guardian_flags = [{ id: 'f1', status: 'open', change_order_id: null }]
    const body: any = await (await revise()).json()
    expect(body.flagDetached).toBeUndefined()
    expect(db.change_orders.find(c => c.id === 'co-rev').flag_id).toBe('f1')
    expect(db.guardian_flags[0]).toMatchObject({ status: 'converted_to_co', change_order_id: 'co-rev' })
  })
  it('the project card tells the user when the flag was not carried over', () => {
    expect(read('components/projects/ProjectDetail.tsx')).toContain('if (json?.flagDetached)')
  })
})

describe('CO-5: a database failure on the flag claim is a 500, not a false conflict', () => {
  it('POST /api/co answers 500 (and creates nothing) when the claim write errors', async () => {
    db.guardian_flags = [{ id: 'f-open', project_id: 'p1', workspace_id: 'ws-1', status: 'open', change_order_id: null }]
    flagClaimWriteError = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res: any = await createCo({ json: async () => ({ projectId: 'p1', title: 'Extra', flagId: 'f-open', lineItems: [{ description: 'W', quantity: 1, rate: 10 }] }) } as any)
    expect(res.status).toBe(500)
    expect(db.change_orders).toHaveLength(0)
  })
})

describe('CO-6: the attachment cap and draft lock are enforced atomically', () => {
  it('the route inserts through co_attachment_add and maps its errors; migration 148 defines it', () => {
    const route = read('app/api/co/[id]/attachments/route.ts')
    expect(route).toContain(".rpc('co_attachment_add'")
    for (const code of ['attachment_limit_exceeded', 'co_locked', 'co_approval_pending', 'co_not_found']) expect(route).toContain(code)
    const sql = read('supabase/migrations/148_co_attachment_add_enforce_cap_under_lock.sql')
    expect(sql).toMatch(/FROM public\.change_orders WHERE id = p_co_id FOR UPDATE/)
    expect(sql).toContain("v_max_attachments CONSTANT integer := 20")
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.co_attachment_add\(.*\) TO service_role/)
  })
})

describe('CO-7: the AI draft request text is cut on a code-point boundary and made storable', () => {
  it('truncateText + stripUnstorableText never leave half an emoji or a NUL', () => {
    const text = 'a'.repeat(2999) + '😀' + 'tail\u0000'
    const out = truncateText(stripUnstorableText(text), 3000)
    expect(out.length).toBeLessThanOrEqual(3000)
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false)
    expect(out.includes('\u0000')).toBe(false)
  })
  it('the draft route uses it instead of slice(0, 3000)', () => {
    const route = read('app/api/co/draft/route.ts')
    expect(route).toContain('truncateText(stripUnstorableText(askText), 3000)')
    expect(route).not.toContain('askText.slice(0, 3000)')
  })
})

describe('CO-4 / CO-9: editor feedback and RichTextField editability', () => {
  it('Save draft goes through handleSaveDraft, which reports "Saved" and swallows the (already shown) rejection', () => {
    const editor = read('components/co/CoEditor.tsx')
    expect(editor).toContain('onClick={handleSaveDraft}')
    expect(editor).not.toContain('onClick={() => doSave(true)}')
    expect(editor).toMatch(/async function handleSaveDraft\(\)[\s\S]*await doSave\(true\)[\s\S]*setSaveStatus\('saved'\)[\s\S]*catch/)
  })
  it('RichTextField follows later changes of `disabled`', () => {
    expect(read('components/ui/RichTextField.tsx')).toContain('editor.setEditable(!disabled)')
  })
})
