// tests/approvals-independent-pass-9.test.ts
//
// Section-11 independent pass 9 (B1–B3). Source-shape tests, same style as the earlier approvals passes:
//   B1 — the cancel route (and project-complete) must act on cancelApprovalRequest's result
//   B2 — retryFailedSend must read its own "record the successful send" write
//   B3 — evaluateApprovalGate's rollback must check the delete and fall back to cancelling

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

describe('B1 — cancel result is reported, not swallowed', () => {
  const route = read('app/api/approvals/[id]/cancel/route.ts')
  it('captures the cancelApprovalRequest result', () => {
    expect(route).toMatch(/const cancelResult = await cancelApprovalRequest\(/)
  })
  it('answers 409 when a send claim blocked the cancel', () => {
    expect(route).toMatch(/if \(!cancelResult\.cancelled\)/)
    expect(route).toMatch(/if \(cancelResult\.blockedBySend\)\s*\n\s*return NextResponse\.json\([^)]*status: 409/)
  })
  it('answers 409 when nothing was cancelled for another reason', () => {
    expect(route).toMatch(/already decided or cancelled[^\n]*status: 409/)
  })
  it('only returns ok after the not-cancelled guard', () => {
    expect(route.indexOf('if (!cancelResult.cancelled)')).toBeLessThan(route.lastIndexOf('return NextResponse.json({ ok: true })'))
  })
  it('project complete only counts real cancels', () => {
    const complete = read('app/api/projects/[id]/complete/route.ts')
    expect(complete).toMatch(/const cancelRes = await cancelApprovalRequest\(/)
    expect(complete).toMatch(/if \(cancelRes\.cancelled\) scopeApprovalsCancelled\+\+/)
    expect(complete).not.toMatch(/\n\s*scopeApprovalsCancelled\+\+\n/)
  })
})

describe('B2 — retryFailedSend verifies the write that records a successful send', () => {
  const engine = read('lib/approvals/engine.ts')
  const retry = engine.slice(engine.indexOf('export async function retryFailedSend'))
  it('selects the updated row so a no-op is detectable', () => {
    expect(retry).toMatch(/\.eq\('status', 'approved'\)\s*\n\s*\.select\('id'\)\.maybeSingle\(\)/)
  })
  it('leaves a send_outcome_unrecorded trail when it could not be recorded', () => {
    expect(retry).toMatch(/if \(!cleared\) \{[\s\S]*approval\.send_outcome_unrecorded[\s\S]*via: 'retry'/)
  })
  it('logs the failed-retry claim release error instead of dropping it', () => {
    expect(retry).toMatch(/const \{ error: reasonErr \}/)
  })
})

describe('B3 — gate rollback checks the delete', () => {
  const engine = read('lib/approvals/engine.ts')
  const gate = engine.slice(engine.indexOf('if (stepsInsertErr)'), engine.indexOf('if (stepsInsertErr)') + 2500)
  it('reads the rollback delete result', () => {
    expect(gate).toMatch(/const \{ error: rollbackErr \} = await service\.from\('approval_requests'\)\.delete\(\)/)
  })
  it('falls back to cancelling the stepless request, CAS on pending', () => {
    expect(gate).toMatch(/status: 'cancelled'[\s\S]*\.eq\('status', 'pending'\)/)
  })
  it('still halts the send', () => {
    expect(gate).toMatch(/throw new Error\('Failed to create approval steps — send halted for safety'\)/)
  })
})
