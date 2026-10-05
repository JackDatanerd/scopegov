// tests/approvals-pass1-round2-fixes.test.ts
//
// Section-11 pass 1 (B1-B3):
//   B1 - migration 129: decide_approval_step's reassign guard must be NULL-safe (role<->person reassign)
//   B2 - SOW send route must select projects.status so its terminal-project check can fire
//   B3 - the approvals banner's Retry send must surface a deliveryWarning

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'


const h = vi.hoisted(() => ({
  selectArg: '',
  projectStatus: 'Complete',
  evaluateApprovalGate: vi.fn(),
  session: { id: 'u1', name: 'U', email: 'u@x.co', workspaceId: 'w1', emailVerifiedAt: '2026-01-01', permissions: ['SEND_SOW'] },
}))

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => h.session,
  hasPermission: (s: any, p: string) => s.permissions.includes(p),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: (arg: string) => {
        h.selectArg = arg
        // Mimic PostgREST: a column not named in the embed is simply absent from the row.
        const projects: any = { id: 'p1', name: 'P', disc: 'D', contract_value: 100, currency: 'USD', type: 'fixed', retainer_duration_months: null }
        if (/projects\([^)]*\bstatus\b/.test(arg)) projects.status = h.projectStatus
        const row = { id: 'aaaaaaaa-0000-4000-8000-000000000001', version: 1, status: 'draft', project_id: 'p1', sections: [], metadata: {}, projects }
        const b: any = { eq: () => b, single: async () => ({ data: row }) }
        return b
      },
    }),
  }),
}))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: async () => true }))
vi.mock('@/lib/approvals/engine', () => ({ evaluateApprovalGate: (...a: any[]) => h.evaluateApprovalGate(...a) }))
vi.mock('@/lib/documents/send-sow', () => ({ sendSowDocument: vi.fn() }))
vi.mock('@/lib/documents/preflight', () => ({ sendBlockedReason: async () => null }))

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')

describe('B1 - migration 129 reassign guard', () => {
  const sql = read('supabase/migrations/129_decide_approval_step_null_safe_reassign_guard.sql')
  it('compares the locked row with IS DISTINCT FROM on both columns', () => {
    expect(sql).toMatch(/v_step_user IS DISTINCT FROM p_expected_approver_user_id/)
    expect(sql).toMatch(/v_step_role IS DISTINCT FROM p_expected_approver_role_id/)
  })
  it('no longer uses the NULL-unsafe NOT (... OR ...) form', () => {
    const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    expect(code).not.toMatch(/IF NOT \(/)
    expect(code).not.toMatch(/p_expected_approver_user_id IS NOT NULL AND/)
  })
  it('keeps the 7-arg signature and the service_role-only grants', () => {
    expect(sql).toMatch(/p_expected_approver_user_id uuid,\s*p_expected_approver_role_id uuid/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.decide_approval_step\(\s*uuid, uuid, text, uuid, text, uuid, uuid\s*\) FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.decide_approval_step\([\s\S]*TO service_role/)
  })
  it('still returns reassigned / rejected / advanced / final', () => {
    for (const o of ['reassigned', 'rejected', 'advanced', 'final', 'conflict']) expect(sql).toContain(`RETURN '${o}'`)
  })
})

describe('B2 - SOW send route terminal-project check', () => {
  beforeEach(() => { h.selectArg = ''; h.evaluateApprovalGate.mockReset() })

  const call = async () => {
    const { POST } = await import('@/app/api/sow/[id]/send/route')
    return POST(new Request('http://x', { method: 'POST', body: '{}' }) as any, { params: Promise.resolve({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }) })
  }

  it('selects projects.status', async () => {
    await call()
    expect(h.selectArg).toMatch(/projects\([^)]*\bstatus\b/)
  })

  it('a Complete project is refused with 409 BEFORE any approval request is created', async () => {
    h.projectStatus = 'Complete'
    const res = await call()
    expect(res.status).toBe(409)
    expect(h.evaluateApprovalGate).not.toHaveBeenCalled()
  })
})

describe('B3 - approvals banner Retry send', () => {
  const src = read('components/approvals/ApprovalsClient.tsx')
  it("post() alerts on deliveryWarning for retry-send", () => {
    const post = src.slice(src.indexOf('async function post('), src.indexOf('// Auto-open the request linked'))
    expect(post).toMatch(/action === 'retry-send' && json\.deliveryWarning/)
    expect(post).toMatch(/alert\(json\.deliveryWarning\)/)
  })
})
