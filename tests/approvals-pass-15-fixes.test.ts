import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const engine = readFileSync('lib/approvals/engine.ts', 'utf8')
const cancelRoute = readFileSync('app/api/approvals/[id]/cancel/route.ts', 'utf8')

describe('Approvals pass 15', () => {
  it('B1: reassign bails out (no audit, no notifications) when the request is no longer pending', () => {
    const fn = engine.slice(engine.indexOf('export async function reassignApprovalStep'), engine.indexOf('export async function getPendingApprovalForDocument'))
    const clock = fn.slice(fn.indexOf('for (let attempt'), fn.indexOf("eventType: 'approval.step_reassigned'"))
    expect(clock).toContain(".select('id').maybeSingle()")
    expect(clock).toMatch(/if \(!clockRow\)\s*\n\s*return \{ ok: false,[\s\S]*status: 409/)
    expect(fn.indexOf('if (!clockRow)')).toBeLessThan(fn.indexOf("eventType: 'approval.step_reassigned'"))
    expect(fn.indexOf('if (!clockRow)')).toBeLessThan(fn.indexOf("type:         'approval_reassigned'"))
  })

  it('B2: cancel verifies the real document status for any request that stamped a send claim', () => {
    expect(cancelRoute).toMatch(/if \(returnedToDraft && \(sendFailed \|\| !!req\.sending_started_at\)\)/)
  })
})
