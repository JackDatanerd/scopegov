import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
const sent: any[] = []
vi.mock('@/lib/email/send', () => ({
  sendEmail: async (payload: any) => { sent.push(payload); return { ok: true, id: 'x' } },
}))

import { insertNextCoVersion } from '@/lib/documents/co-version'
import { sendCoEmail } from '@/lib/email/templates'
import { rescaleLineItemsToTotal } from '@/lib/utils/rescale-line-items'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// Minimal in-memory stand-in for the slice of the Supabase client insertNextCoVersion touches.
function fakeService(attachments: any[]) {
  const inserted: Record<string, any[]> = { change_orders: [], co_attachments: [] }
  const service = {
    from(table: string) {
      const q: any = {
        _filters: {} as Record<string, any>,
        select() { return q },
        or() { return q },
        order() { return q },
        limit() { return q },
        eq(col: string, val: any) { q._filters[col] = val; return q },
        maybeSingle: async () => ({ data: { version: 1 } }),
        single: async () => ({ data: { id: 'new-co', version: 2 }, error: null }),
        insert(rows: any) { inserted[table].push(rows); return q },
        then(resolve: any) {
          // Awaiting `.from('co_attachments').select(...).eq('co_id', x)` resolves to the parent's rows.
          const data = table === 'co_attachments' ? attachments.filter(a => a.co_id === q._filters.co_id) : []
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      }
      return q
    },
  }
  return { service, inserted }
}

describe('CO revise carries attachments forward (co-version.ts)', () => {
  it('copies the parent CO attachment rows onto the new draft, same storage_path', async () => {
    const { service, inserted } = fakeService([
      { co_id: 'parent', file_name: 'a.pdf', file_size: 10, mime_type: 'application/pdf', storage_path: 'w/co/parent/x.pdf', uploaded_by: 'u1' },
      { co_id: 'other',  file_name: 'z.pdf', file_size: 10, mime_type: 'application/pdf', storage_path: 'w/co/other/z.pdf',  uploaded_by: 'u1' },
    ].map(a => ({ ...a })))
    const res = await insertNextCoVersion(service, 'root', { parent_co_id: 'parent', title: 't' })
    expect(res.ok).toBe(true)
    expect(inserted.co_attachments).toHaveLength(1)
    expect(inserted.co_attachments[0]).toEqual([
      { co_id: 'new-co', file_name: 'a.pdf', file_size: 10, mime_type: 'application/pdf', storage_path: 'w/co/parent/x.pdf', uploaded_by: 'u1' },
    ])
  })

  it('does nothing extra when there is no parent_co_id', async () => {
    const { service, inserted } = fakeService([])
    const res = await insertNextCoVersion(service, 'root', { title: 't' })
    expect(res.ok).toBe(true)
    expect(inserted.co_attachments).toHaveLength(0)
  })
})

describe('CO section pass regressions (source guards)', () => {
  it('draft route maps a null/blank timelineImpactDays to null instead of Number(null) === 0', () => {
    const src = read('app/api/co/draft/route.ts')
    expect(src).not.toMatch(/const days = Number\(parsed\.timelineImpactDays\)/)
    expect(src).toMatch(/rawDays === null \|\| rawDays === undefined/)
  })

  it('exception route never defaults a credit CO\'s negative total into the value field', () => {
    expect(read('app/api/co/[id]/exception/route.ts')).toMatch(/Math\.max\(0, Number\(co\.total\) \|\| 0\)/)
  })

  it('CoCard hides Escalate for exactly the statuses the escalate route refuses', () => {
    const ui = read('components/projects/ProjectDetail.tsx')
    const m = ui.match(/const ESCALATE_BLOCKED_STATUSES = \[([^\]]*)\]/)
    expect(m).not.toBeNull()
    const uiSet = m![1].split(',').map(s => s.trim().replace(/['"]/g, '')).sort()
    const route = read('app/api/co/[id]/escalate/route.ts')
    const r = route.match(/if \(\[([^\]]*)\]\.includes\(co\.status\)\)/)
    expect(r).not.toBeNull()
    const routeSet = r![1].split(',').map(s => s.trim().replace(/['"]/g, '')).sort()
    expect(uiSet).toEqual(routeSet)
  })

  it('CO attachment DELETE only removes the storage object when no row references it', () => {
    const src = read('app/api/co/[id]/attachments/[attachmentId]/route.ts')
    expect(src).toMatch(/stillReferenced/)
    expect(src).toMatch(/\.eq\('storage_path', attachment\.storage_path\)/)
  })

  it('project page selects is_credit so the CoCard exception hint can distinguish credit COs', () => {
    expect(read('app/(app)/projects/[id]/page.tsx')).toMatch(/is_retainer_renewal, is_credit\)/)
  })
})

describe('CO send email (templates.ts)', () => {
  const base = { to: 'c@client.test', clientName: 'Acme', agencyName: 'Agency', projectName: 'Site', coTitle: 'Extra pages',
    currency: 'USD', portalUrl: 'https://app.test/portal/co/t' }

  it('renders the rich-text note as HTML, not as escaped markup', async () => {
    sent.length = 0
    await sendCoEmail({ ...base, total: 1200, note: '<p>Because of <strong>new</strong> scope</p>' })
    expect(sent[0].html).toContain('<strong>new</strong>')
    expect(sent[0].html).not.toContain('&lt;p&gt;')
  })

  it('strips unsafe markup from the note', async () => {
    sent.length = 0
    await sendCoEmail({ ...base, total: 1200, note: '<p>hi</p><script>alert(1)</script><a href="javascript:x">x</a>' })
    expect(sent[0].html).not.toContain('<script')
    expect(sent[0].html).not.toContain('javascript:')
  })

  it('words a credit CO as a credit with the absolute amount', async () => {
    sent.length = 0
    await sendCoEmail({ ...base, total: -500, isCredit: true })
    expect(sent[0].html).toContain('credit change order')
    expect(sent[0].html).toContain('Credit USD 500.00')
    expect(sent[0].html).not.toContain('-500')
    expect(sent[0].html).not.toContain('scope additions')
  })
})

describe('rescaleLineItemsToTotal sums the printed row totals', () => {
  it('does not add a phantom one-cent adjustment when several rows each rounded up at the row', () => {
    // Each row: 1.33 x 10.05 = 13.3665, which co-totals.ts prints as 13.37. Two rows print 26.74, but
    // re-multiplying qty x rate and summing gives 26.733 -> 26.73, a cent off the document the client reads.
    const row = (id: string) => ({ id, description: 'Work', quantity: 1.33, rate: 10.05, total: 13.37 })
    const out = rescaleLineItemsToTotal([row('a'), row('b')] as any, 26.74, 0, false)
    expect(out.lineItems).toHaveLength(2) // the client's own total was accepted as-is: no adjustment line
    expect(out.total).toBe(26.74)
  })

  it('still adds a real adjustment line for a genuine counter-offer', () => {
    const out = rescaleLineItemsToTotal([{ id: 'a', description: 'W', quantity: 1, rate: 100, total: 100 }] as any, 80, 0, false)
    expect(out.lineItems).toHaveLength(2)
    expect(out.lineItems[1].total).toBe(-20)
  })
})

describe('CO exception client email', () => {
  it('never forwards the internal exception reason to the client', () => {
    const src = read('app/api/co/[id]/exception/route.ts')
    const call = src.slice(src.indexOf('sendCoExceptionGrantedEmail({'), src.indexOf("'CO exception granted (client) email'"))
    expect(call).not.toMatch(/note:\s*reasonText/)
  })
})
