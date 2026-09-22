import { describe, it, expect, vi } from 'vitest'
import { finalizeCoAcceptance } from '@/lib/documents/finalize-co'

// finalize-co.ts imports lib/pdf/renderer.tsx (React-PDF JSX) purely to
// build the acceptance-confirmation PDF attachment — a step these tests
// never reach (both race-condition cases return before that code runs).
// Mock it so this stays a fast, isolated unit test of the CAS logic
// rather than pulling React-PDF's JSX into the test transform pipeline.
// vi.mock calls are hoisted above imports by vitest's transform, so this
// takes effect before finalize-co.ts (and its renderer import) load,
// even though it's written after the import above.
vi.mock('@/lib/pdf/renderer', () => ({ renderCoPdf: vi.fn() }))

// The new "array expectedStatus succeeds" test below is the first test in
// this file to reach PAST the CAS write — every side-effecting call after
// it (email sends, notifications, JWT/reply-to/cc lookups) is mocked out
// so this stays a fast, isolated unit test of the CAS logic, not an
// integration test that hits real email delivery.
vi.mock('@/lib/utils/permissions-query', () => ({ getMemberEmailsWithPermission: vi.fn(() => Promise.resolve([])) }))
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/email/delivery', () => ({ checkedSend: vi.fn(() => Promise.resolve()) }))
vi.mock('@/lib/email/reply-to', () => ({ resolveReplyTo: vi.fn(() => Promise.resolve(null)) }))
vi.mock('@/lib/utils/client-contacts', () => ({ withPrimaryContactCc: vi.fn(() => Promise.resolve([])) }))
vi.mock('@/lib/utils/workspace-secret', () => ({ getWorkspaceJwtSecret: vi.fn(() => Promise.resolve(null)) }))
vi.mock('@/lib/documents/co-contract-value', () => ({ getContractValueBefore: vi.fn(() => Promise.resolve(null)) }))
vi.mock('@/lib/documents/executed-pdf', () => ({
  computeContentHash: vi.fn(() => 'fake-hash'),
  storeExecutedPdf: vi.fn(() => Promise.resolve(null)),
}))

// Minimal chainable fake matching the subset of the Supabase query builder
// finalizeCoAcceptance actually uses. Real supabase-js builders are
// PromiseLike — awaiting the chain (without an explicit terminal call)
// resolves to { data, error } — so `then` is the only thing that needs to
// actually do something; every other chain method just returns `this`.
function mockService(perTable: Record<string, { data: any; error?: any }>) {
  const calls: Record<string, number> = {}
  const from = (table: string) => {
    calls[table] = (calls[table] || 0) + 1
    const result = perTable[table] ?? { data: null, error: null }
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      order: () => builder,
      limit: () => builder,
      single: () => builder,
      update: () => builder,
      insert: () => builder,
      then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
    }
    return builder
  }
  return { from, calls, storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: null } }) }) } }
}

const baseCo = {
  id: 'co-1',
  project_id: 'proj-1',
  workspace_id: 'ws-1',
  title: 'Extra scope',
  total: 5000,
  flag_id: null,
  line_items: [],
  projects: {
    id: 'proj-1',
    name: 'Test Project',
    currency: 'USD',
    clients: { name: 'Client Co', email: 'client@example.com', cc_emails: [] },
    workspaces: { id: 'ws-1', agency_name: 'Test Agency', brand_colour: '#000', logo_storage_path: null },
  },
}

describe('finalizeCoAcceptance — race-condition compare-and-swap (re-audit fix)', () => {
  it('returns a 409 "already accepted" result and does NOT proceed to create an amendment when the CAS update matches zero rows (lost race)', async () => {
    const service = mockService({
      sow_documents:  { data: { id: 'sow-1' }, error: null },
      // Empty array = zero rows matched the .eq('status', expectedStatus)
      // filter — a concurrent request already flipped this CO's status.
      change_orders:  { data: [], error: null },
    })

    const result = await finalizeCoAcceptance(service, {
      co: baseCo,
      signerName: 'Jane Client',
      signatureData: 'data:image/png;base64,abc',
      source: 'direct',
      expectedStatus: 'awaiting_response',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.error).toMatch(/already accepted/i)
    }
    // The whole point of the CAS: a lost race must never reach the
    // amendments table — that's what would double the financial_impact.
    expect(service.calls['amendments']).toBeUndefined()
  })

  it('returns a 500 result (not a throw) when the CAS update itself errors', async () => {
    const service = mockService({
      sow_documents: { data: { id: 'sow-1' }, error: null },
      change_orders: { data: null, error: { message: 'connection reset' } },
    })

    const result = await finalizeCoAcceptance(service, {
      co: baseCo,
      signerName: 'Jane Client',
      signatureData: 'data:image/png;base64,abc',
      source: 'direct',
      expectedStatus: 'awaiting_response',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(500)
    expect(service.calls['amendments']).toBeUndefined()
  })

  it('still rejects cleanly when no signed SOW exists for the project (pre-existing guard, unaffected by the CAS change)', async () => {
    const service = mockService({
      sow_documents: { data: null, error: null },
    })

    const result = await finalizeCoAcceptance(service, {
      co: baseCo,
      signerName: 'Jane Client',
      signatureData: 'data:image/png;base64,abc',
      source: 'direct',
      expectedStatus: 'awaiting_response',
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(422)
  })

  // FIX (portal audit, section 18 re-pass): app/api/portal/co/[token]/accept
  // used to pass the single string 'awaiting_response' as expectedStatus,
  // even though its own pre-check (CLIENT_RESPONDABLE_STATUSES) lets a CO
  // in the 'stalled' status through too — co-stall flips a CO to 'stalled'
  // after 5 days with no client reply. A stalled CO going through direct
  // accept passed the pre-check, then failed this CAS (matched against
  // 'awaiting_response' alone), and got a false "already accepted" 409.
  // No existing test exercised this path — this is the regression test.
  it('accepts a CO whose expectedStatus is passed as an array (e.g. the stalled CO going through direct accept)', async () => {
    const service = mockService({
      sow_documents:  { data: { id: 'sow-1', document_number: 'SOW-001' }, error: null },
      // Non-empty array = the CAS matched — the row really was in one of
      // the array's statuses (here, 'stalled') before this update.
      change_orders:  { data: [{ id: 'co-1' }], error: null },
      amendments:     { data: null, error: null },
    })

    const result = await finalizeCoAcceptance(service, {
      co: baseCo,
      signerName: 'Jane Client',
      signatureData: 'data:image/png;base64,abc',
      source: 'direct',
      // The real fix: pass the full respondable-status array, not a single string.
      expectedStatus: ['awaiting_response', 'stalled'],
    })

    expect(result.ok).toBe(true)
  })
})
