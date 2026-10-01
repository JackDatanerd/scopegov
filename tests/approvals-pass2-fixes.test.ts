// tests/approvals-pass2-fixes.test.ts
//
// Section-11 fresh pass (findings 1-6):
//   1 - pickWorkflow: an opted-in "also gate other currencies" workflow must outrank a catch-all for a foreign-currency document
//   2 - cancelApprovalRequest reports when it refused because a send is running; invoice DELETE honours that (incl. retry claims)
//   3 - decision email: no "approved and sent" when the client email bounced
//   4 - gate: a second Send click during the final send is told it is being sent, not "sent for approval"
//   5 - ApprovalsClient: the oversight landing filter does not follow the member to other tabs
//   6 - workflow editor refuses a zero threshold client-side (the server already does)

import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

vi.mock('@/lib/auth/session', () => ({
  hasPermission: (session: any, permission: string) => session.permissions.includes(permission),
}))

import { cancelApprovalRequest, evaluateApprovalGate } from '@/lib/approvals/engine'
import { pickWorkflow } from '@/lib/approvals/pick-workflow'
import { SEND_IN_FLIGHT_MESSAGE } from '@/lib/approvals/send-claim'

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

const w = (id: string, threshold: number | null, currency: string | null, other = false) =>
  ({ id, threshold_amount: threshold, threshold_currency: currency, apply_to_other_currencies: other })

describe('finding 1 - pickWorkflow: catch-all vs "also gate other currencies"', () => {
  const catchAll = w('a-catchall', null, null)
  const senior   = w('b-usd-10k', 10000, 'USD', true)

  it('a foreign-currency document gets the opted-in workflow, not the (lighter) catch-all', () => {
    expect(pickWorkflow([catchAll, senior], 50000, 'EUR')?.id).toBe('b-usd-10k')
    expect(pickWorkflow([senior, catchAll], 1, 'EUR')?.id).toBe('b-usd-10k')
  })
  it('same-currency behaviour is unchanged: a cleared threshold beats the catch-all, an uncleared one falls to it', () => {
    expect(pickWorkflow([catchAll, senior], 50000, 'USD')?.id).toBe('b-usd-10k')
    expect(pickWorkflow([catchAll, senior], 5, 'USD')?.id).toBe('a-catchall')
  })
  it('without the opt-in flag a foreign-currency document still falls to the catch-all', () => {
    expect(pickWorkflow([catchAll, w('b', 10000, 'USD', false)], 50000, 'EUR')?.id).toBe('a-catchall')
  })
  it('a document in the opted-in workflow\'s OWN currency below its threshold is not captured by the flag', () => {
    expect(pickWorkflow([catchAll, senior], 100, 'USD')?.id).toBe('a-catchall')
  })
  it('with no catch-all the old results hold', () => {
    expect(pickWorkflow([senior], 5, 'KES')?.id).toBe('b-usd-10k')
    expect(pickWorkflow([w('a', 1000, 'USD')], 5_000_000, 'KES')).toBeNull()
  })
})

/** Stub whose select() answers differ per call: the first read is the lookup rows, later reads are `reread`. */
function seqService(opts: { lookup: any[]; reread?: any; updateResult?: any }) {
  let selects = 0
  function builder(resolveWith: () => any): any {
    const b: any = new Proxy(function () {}, {
      get(_t, prop: string) {
        if (prop === 'then') return (res: any, rej: any) => Promise.resolve(resolveWith()).then(res, rej)
        if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(resolveWith())
        return () => b
      },
    })
    return b
  }
  return {
    from: () => ({
      select: () => { const n = selects++; return builder(() => ({ data: n === 0 ? opts.lookup : opts.reread ?? null, error: null })) },
      update: () => builder(() => ({ data: opts.updateResult ?? null, error: null })),
      insert: () => builder(() => ({ data: null, error: null })),
    }),
  } as any
}

const baseParams = {
  documentType: 'invoice' as const, documentId: 'd1', workspaceId: 'w1',
  actorId: 'u1', actorEmail: 'a@b.c', actorName: 'A',
}
const justNow = () => new Date(Date.now() - 5_000).toISOString()

describe('finding 2 - cancelApprovalRequest reports a refused cancel', () => {
  it('nothing to cancel -> not cancelled, not blocked', async () => {
    expect(await cancelApprovalRequest(seqService({ lookup: [] }), baseParams)).toEqual({ cancelled: false, blockedBySend: false })
  })
  it('a live send claim (original or retry) -> blockedBySend', async () => {
    const pending  = { id: 'r1', project_id: 'p', current_step: 1, context: {}, status: 'pending',  requested_by: 'u1', sending_started_at: justNow() }
    const retrying = { ...pending, status: 'approved' }
    expect((await cancelApprovalRequest(seqService({ lookup: [pending] }), baseParams)).blockedBySend).toBe(true)
    expect((await cancelApprovalRequest(seqService({ lookup: [retrying] }), baseParams)).blockedBySend).toBe(true)
  })
  it('a claim that lands between the read and the guarded write -> blockedBySend (re-read)', async () => {
    const row = { id: 'r1', project_id: 'p', current_step: 1, context: {}, status: 'pending', requested_by: 'u1', sending_started_at: null }
    const res = await cancelApprovalRequest(seqService({ lookup: [row], updateResult: null, reread: { status: 'pending', sending_started_at: justNow() } }), baseParams)
    expect(res).toEqual({ cancelled: false, blockedBySend: true })
  })
  it('a guarded write that matched because the request was simply resolved -> not blocked', async () => {
    const row = { id: 'r1', project_id: 'p', current_step: 1, context: {}, status: 'pending', requested_by: 'u1', sending_started_at: null }
    const res = await cancelApprovalRequest(seqService({ lookup: [row], updateResult: null, reread: { status: 'approved', sending_started_at: null } }), baseParams)
    expect(res).toEqual({ cancelled: false, blockedBySend: false })
  })
  it('a successful cancel -> cancelled', async () => {
    const row = { id: 'r1', project_id: 'p', current_step: 1, context: {}, status: 'pending', requested_by: 'u1', sending_started_at: null }
    const res = await cancelApprovalRequest(seqService({ lookup: [row], updateResult: { id: 'r1' } }), baseParams)
    expect(res.cancelled).toBe(true)
  })
  it('invoice DELETE uses the any-claim in-flight check and stops on a refused cancel', () => {
    const src = read('app/api/invoices/[id]/route.ts')
    const del = src.slice(src.indexOf('export async function DELETE'))
    expect(del).toMatch(/approvalSendInFlight\(service, session\.workspaceId, \['invoice'\], id\)/)
    expect(del).toMatch(/cancelResult\.blockedBySend/)
    expect(del).not.toMatch(/active\?\.status === 'pending' && isSendClaimLive/)
  })
})

describe('finding 3 - decision email on a bounced client email', () => {
  const src = read('lib/email/templates.ts')
  it('does not claim "approved and sent" / "sent to the client automatically" when there is a delivery warning', () => {
    expect(src).toMatch(/deliveryWarning \? `\$\{documentLabel\} approved — client email not delivered`/)
    expect(src).toMatch(/approved && autoSent && !deliveryWarning \? ' It has been sent to the client automatically\.'/)
    expect(src).toMatch(/approved && autoSent && deliveryWarning \? ' It was sent, but the email to the client did not go out\.'/)
  })
})

describe('finding 4 - gate during the final send', () => {
  const gateService = (row: any) => ({
    from: () => {
      const b: any = new Proxy(function () {}, {
        get(_t, prop: string) {
          if (prop === 'then') return (res: any, rej: any) => Promise.resolve({ data: [row], error: null }).then(res, rej)
          return () => b
        },
      })
      return b
    },
  }) as any
  const params = {
    workspaceId: 'w1', documentType: 'sow' as const, documentId: 'd1', projectId: 'p1', projectName: 'P',
    amount: 1, currency: 'USD', documentTitle: 'T', requestedBy: { id: 'u1', name: 'U', email: 'u@x.co' },
  }
  it('a pending request whose send is running -> blocked 409 with the in-flight message', async () => {
    const r = await evaluateApprovalGate(gateService({ id: 'r1', status: 'pending', send_failed_at: null, sending_started_at: justNow() }), params)
    expect(r).toMatchObject({ requiresApproval: true, blocked: true, status: 409, error: SEND_IN_FLIGHT_MESSAGE, approvalRequestId: 'r1' })
  })
  it('an ordinary pending request still answers "waiting for approval"', async () => {
    const r = await evaluateApprovalGate(gateService({ id: 'r1', status: 'pending', send_failed_at: null, sending_started_at: null }), params)
    expect(r).toEqual({ requiresApproval: true, approvalRequestId: 'r1' })
  })
  it('a long-dead claim is not reported as an active send', async () => {
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const r = await evaluateApprovalGate(gateService({ id: 'r1', status: 'pending', send_failed_at: null, sending_started_at: stale }), params)
    expect(r.blocked).toBeUndefined()
  })
})

describe('finding 5 - ApprovalsClient filter does not leak across tabs', () => {
  const src = read('components/approvals/ApprovalsClient.tsx')
  it('tab buttons go through selectTab, which resets the filters', () => {
    expect(src).toMatch(/onClick=\{\(\) => selectTab\(t\.id\)\}/)
    expect(src).toMatch(/setStatusFilter\(next === 'all' && !canApprove && canViewAll \? 'pending' : ''\)/)
    expect(src).not.toMatch(/onClick=\{\(\) => setTab\(t\.id\)\}/)
  })
})

describe('finding 6 - workflow editor zero threshold', () => {
  it('refuses 0 and negatives client-side, matching parseThresholdAmount', () => {
    const src = read('components/settings/ApprovalWorkflowsClient.tsx')
    expect(src).toMatch(/Number\(threshold\) <= 0/)
    expect(src).not.toMatch(/Number\(threshold\) < 0/)
  })
})
