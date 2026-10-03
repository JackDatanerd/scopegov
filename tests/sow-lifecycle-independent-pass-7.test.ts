// tests/sow-lifecycle-independent-pass-7.test.ts
//
// SOW lifecycle (section 9), independent pass:
//   B1 — sendSowDocument took a document number BEFORE its draft -> awaiting_signature compare-and-swap, so every
//        request that lost the race burned a number (gap in the SOW sequence), and a failed claim write was
//        reported as "already sent by another action". It now claims first, numbers second, and releases the
//        claim if numbering fails — the same order send-co.ts already used.
//   B2 — the Payment Schedule footer formatted its totals to whole units while validateSowForSend blocks at a
//        difference of 0.01, so a 30-cent mismatch read "Under by $0" in red. It now prints minor units.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createFakeSupabase } from './helpers/fake-supabase'

const h = vi.hoisted(() => ({
  assignCalls: 0,
  assignThrows: false,
  nextNumber: 'SOW-0007',
  // Runs between the initial read and the claim — lets a test play "another request won the race".
  betweenReadAndClaim: null as null | (() => void),
  emails: [] as any[],
}))

vi.mock('jose', () => ({
  SignJWT: class {
    setProtectedHeader() { return this }
    setExpirationTime() { return this }
    setJti() { return this }
    async sign() { return 'test.jwt.token' }
  },
}))
vi.mock('nanoid', () => ({ nanoid: () => 'jti' }))
vi.mock('@/lib/email/templates', () => ({
  sendSowEmail: async (args: any) => { h.emails.push(args); return { ok: true } },
}))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => {} }))
vi.mock('@/lib/utils/document-number', () => ({
  assignDocumentNumber: async () => {
    h.assignCalls++
    if (h.assignThrows) throw new Error('numbering unavailable')
    return h.nextNumber
  },
}))
vi.mock('@/lib/utils/workspace-secret', () => ({ getWorkspaceJwtSecret: async () => 'secret' }))
vi.mock('@/lib/utils/client-contacts', () => ({
  withPrimaryContactCc: async () => {
    h.betweenReadAndClaim?.()
    return []
  },
}))
vi.mock('@/lib/sow/validate-send', () => ({ validateSowForSend: () => ({ errors: [], warnings: [] }) }))
vi.mock('@/lib/email/delivery', () => ({
  checkedSend: async (fn: () => Promise<any>) => { await fn(); return { ok: true } },
}))
vi.mock('@/lib/email/reply-to', () => ({ resolveReplyTo: async () => undefined }))

const sowRow = (over: Record<string, any> = {}) => ({
  id: 'sow1', version: 1, status: 'draft', project_id: 'p1', workspace_id: 'w1',
  document_number: null, token: null, sent_at: null, expires_at: null,
  sections: [], metadata: {},
  projects: {
    id: 'p1', name: 'Proj', disc: null, status: 'Draft', contract_value: 1000, currency: 'USD',
    client_id: 'c1', deleted_at: null,
    clients: { name: 'Client', email: 'client@test.dev', cc_emails: [] },
    workspaces: { id: 'w1', agency_name: 'Agency', brand_colour: '#000', logo_storage_path: null },
  },
  ...over,
})

const params = { sowId: 'sow1', workspaceId: 'w1', actorId: 'u1', actorEmail: 'a@test.dev', actorName: 'Actor' }

async function load() {
  return (await import('@/lib/documents/send-sow')).sendSowDocument
}

beforeEach(() => {
  h.assignCalls = 0; h.assignThrows = false; h.nextNumber = 'SOW-0007'
  h.betweenReadAndClaim = null; h.emails = []
})

describe('B1 — SOW send claims the row before it takes a document number', () => {
  it('numbers a draft exactly once and stores the number with the claim', async () => {
    const send = await load()
    const { client, tables } = createFakeSupabase({ sow_documents: [sowRow()], projects: [{ id: 'p1', status: 'Draft' }] })
    const res: any = await send(client, params)
    expect(res.ok).toBe(true)
    expect(res.documentNumber).toBe('SOW-0007')
    expect(h.assignCalls).toBe(1)
    const row = tables.sow_documents[0]
    expect(row.status).toBe('awaiting_signature')
    expect(row.document_number).toBe('SOW-0007')
    expect(row.token).toBe('test.jwt.token')
    expect(h.emails).toHaveLength(1)
  })

  it('keeps an existing number and does not take another', async () => {
    const send = await load()
    const { client, tables } = createFakeSupabase({ sow_documents: [sowRow({ document_number: 'SOW-0003' })], projects: [] })
    const res: any = await send(client, params)
    expect(res.ok).toBe(true)
    expect(res.documentNumber).toBe('SOW-0003')
    expect(h.assignCalls).toBe(0)
    expect(tables.sow_documents[0].document_number).toBe('SOW-0003')
  })

  it('a request that loses the race gets 409 and does NOT burn a number', async () => {
    const send = await load()
    const { client, tables } = createFakeSupabase({ sow_documents: [sowRow()], projects: [] })
    // Another request sends the SOW after this one read it as a draft but before it claims it.
    h.betweenReadAndClaim = () => {
      Object.assign(tables.sow_documents[0], { status: 'awaiting_signature', token: 'winner-token', document_number: 'SOW-0006' })
    }
    const res: any = await send(client, params)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(h.assignCalls).toBe(0)
    expect(h.emails).toHaveLength(0)
    // The winner's state is untouched.
    expect(tables.sow_documents[0].token).toBe('winner-token')
    expect(tables.sow_documents[0].document_number).toBe('SOW-0006')
  })

  it('a numbering failure releases the claim: the SOW is a draft again, nothing is emailed', async () => {
    const send = await load()
    h.assignThrows = true
    const { client, tables } = createFakeSupabase({ sow_documents: [sowRow()], projects: [{ id: 'p1', status: 'Draft' }] })
    const res: any = await send(client, params)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(500)
    const row = tables.sow_documents[0]
    expect(row.status).toBe('draft')
    expect(row.token).toBeNull()
    expect(row.sent_at).toBeNull()
    expect(row.expires_at).toBeNull()
    expect(row.document_number).toBeNull()
    expect(h.emails).toHaveLength(0)
    // The project was not dragged to Awaiting Signature by a send that never happened.
    expect(tables.projects[0].status).toBe('Draft')
  })

  it('a failed claim write is reported as an error, not as "already sent", and takes no number', async () => {
    const send = await load()
    const { client, tables } = createFakeSupabase(
      { sow_documents: [sowRow()], projects: [] },
      { errors: [{ table: 'sow_documents', op: 'update', message: 'connection reset' }] },
    )
    const res: any = await send(client, params)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(500)
    expect(res.error).not.toMatch(/already sent/i)
    expect(h.assignCalls).toBe(0)
    expect(tables.sow_documents[0].status).toBe('draft')
  })

  it('a failed number write releases the claim too', async () => {
    const send = await load()
    const { client, tables } = createFakeSupabase(
      { sow_documents: [sowRow()], projects: [] },
      // The first update is the claim; the second is the number write.
      { errors: [{ table: 'sow_documents', op: 'update', message: 'write failed', when: (p: any) => 'document_number' in p && Object.keys(p).length === 1 }] },
    )
    const res: any = await send(client, params)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(500)
    expect(tables.sow_documents[0].status).toBe('draft')
    expect(tables.sow_documents[0].token).toBeNull()
    expect(h.emails).toHaveLength(0)
  })
})

describe('B2 — Payment Schedule footer prints exact amounts', () => {
  it('whole-unit formatting hides a 30-cent mismatch; exact formatting shows it', async () => {
    const { formatCurrency, formatCurrencyExact } = await import('@/lib/utils/format')
    expect(formatCurrency(0.3, 'USD')).toBe('$0')
    expect(formatCurrencyExact(0.3, 'USD')).toBe('$0.30')
    expect(formatCurrencyExact(1000.3, 'USD')).not.toBe(formatCurrencyExact(1000, 'USD'))
  })

  it('the SowEditor footer uses the exact formatter for all three figures', () => {
    const src = readFileSync(path.resolve(__dirname, '../components/sow/SowEditor.tsx'), 'utf8')
    expect(src).toContain("import { countWords, formatCurrencyExact } from '@/lib/utils/format'")
    expect(src).toContain("formatCurrencyExact(scheduleTotal, currency || 'USD')")
    expect(src).toContain("formatCurrencyExact(contractValue as number, currency || 'USD')")
    expect(src).toContain("formatCurrencyExact(Math.abs(variance), currency || 'USD')")
    // No whole-unit formatCurrency( call left anywhere in the editor.
    expect(src).not.toMatch(/\bformatCurrency\(/)
  })
})
