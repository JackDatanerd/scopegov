import { describe, it, expect, beforeEach, vi } from 'vitest'
import { __setResendForTests } from '@/lib/email/send'
import {
  sendInvoiceEmail, sendInvoiceReminderEmail, sendInvoiceSentInternalEmail, sendInvoiceOverdueInternalEmail,
  sendInvoiceDisputedEmail, sendInvoiceDisputeResolvedEmail, sendInvoicePaymentRecordedEmail, sendEscalationEmail,
} from '@/lib/email/templates'

// ── stale-workspace guard on notification writes ─────────────────────────────
let calls: string[] = []
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') return undefined
        if (prop === 'error') return null
        if (prop === 'data') return []
        if (prop === 'count') return 0
        if (prop === 'update' || prop === 'delete' || prop === 'upsert') return () => { calls.push(prop); return chain }
        if (prop === 'select' ) return () => chain
        if (prop === 'maybeSingle') return async () => ({ data: null, error: null })
        if (prop === 'insert') return async () => { calls.push('insert'); return { error: null } }
        return () => chain
      },
    })
    return { from: () => chain }
  },
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'a@x.test', name: 'A', workspaceId: 'w-current', workspaceName: 'W' }),
}))

import { PATCH as notifPatch, DELETE as notifDelete } from '@/app/api/notifications/route'
import { PATCH as prefPatch } from '@/app/api/notifications/preferences/route'

const req = (body: any) => ({ json: async () => body }) as any
const ID = '11111111-1111-4111-8111-111111111111'

beforeEach(() => { calls = [] })

describe('notification writes refuse a tab that is stale after a workspace switch', () => {
  it('PATCH /api/notifications (mark read) → 409, nothing written', async () => {
    const res = await notifPatch(req({ all: true, workspaceId: 'w-old' }))
    expect(res.status).toBe(409)
    expect(calls).toEqual([])
  })
  it('DELETE /api/notifications (clear read / delete one) → 409, nothing deleted', async () => {
    const a = await notifDelete(req({ allRead: true, workspaceId: 'w-old' }))
    const b = await notifDelete(req({ ids: [ID], workspaceId: 'w-old' }))
    expect(a.status).toBe(409); expect(b.status).toBe(409)
    expect(calls).toEqual([])
  })
  it('PATCH /api/notifications/preferences → 409, nothing written', async () => {
    const res = await prefPatch(req({ eventType: 'sow_signed', enabled: false, workspaceId: 'w-old' }))
    expect(res.status).toBe(409)
    expect(calls).toEqual([])
  })
  it('a matching workspaceId, or none (older client), still works', async () => {
    expect((await notifPatch(req({ all: true, workspaceId: 'w-current' }))).status).toBe(200)
    expect((await notifPatch(req({ ids: [ID] }))).status).toBe(200)
    expect((await notifDelete(req({ ids: [ID], workspaceId: 'w-current' }))).status).toBe(200)
    expect((await prefPatch(req({ eventType: 'sow_signed', enabled: false, workspaceId: 'w-current' }))).status).toBe(200)
  })
})

// ── invoice number / entity type are escaped in the HTML body ────────────────
describe('email templates escape the invoice number and entity type', () => {
  let sent: any[] = []
  beforeEach(() => {
    sent = []
    __setResendForTests({ emails: { send: async (b: any) => { sent.push(b); return { data: { id: 'x' }, error: null } } } } as any)
  })
  const BAD = '<img src=x onerror=alert(1)>'
  const base = { clientName: 'C', agencyName: 'A', projectName: 'P', currency: 'USD', portalUrl: 'https://x/y', projectUrl: 'https://x/y', invoiceNumber: BAD }

  it('no template lets the number through as markup, and subjects keep the raw text', async () => {
    await sendInvoiceEmail({ ...base, to: 'c@d.com', title: 'T', amount: 10 })
    await sendInvoiceReminderEmail({ ...base, to: 'c@d.com', title: 'T', balanceDue: 10 })
    await sendInvoiceSentInternalEmail({ ...base, to: ['a@b.com'], amount: 10 })
    await sendInvoiceOverdueInternalEmail({ ...base, to: ['a@b.com'], balanceDue: 10 })
    await sendInvoiceDisputedEmail({ ...base, to: ['a@b.com'], note: 'n' })
    await sendInvoiceDisputeResolvedEmail({ ...base, to: 'c@d.com', note: 'n' })
    await sendInvoicePaymentRecordedEmail({ ...base, to: ['a@b.com'], amount: 10, isFullyPaid: true, balanceRemaining: 0 })
    expect(sent).toHaveLength(7)
    for (const m of sent) {
      expect(m.html).not.toContain('<img src=x')
      expect(m.html).toContain('&lt;img src=x')
    }
    expect(sent[0].subject).toContain(BAD)
  })

  it('escalation entity type is escaped', async () => {
    await sendEscalationEmail({ to: 'a@b.com', assigneeName: 'A', agencyName: 'X', entityType: BAD, entityName: 'E', note: 'n', url: 'https://x/y' })
    expect(sent[0].html).not.toContain('<img src=x')
    expect(sent[0].html).toContain('&lt;img src=x')
  })

  it('ordinary invoice numbers are unchanged', async () => {
    await sendInvoiceEmail({ ...base, invoiceNumber: 'INV-0042', to: 'c@d.com', title: 'T', amount: 10 })
    expect(sent[0].html).toContain('Invoice INV-0042')
  })
})
