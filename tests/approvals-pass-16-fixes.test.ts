import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const sowRoute = readFileSync('app/api/sow/[id]/route.ts', 'utf8')
const sowPage = readFileSync('app/(app)/projects/[id]/sow/[sowId]/page.tsx', 'utf8')
const detail = readFileSync('components/projects/ProjectDetail.tsx', 'utf8')

describe('Approvals pass 16', () => {
  it('B4: GET /api/sow/[id] reports a pending or approved-but-unsent approval for a draft', () => {
    const get = sowRoute.slice(sowRoute.indexOf('export async function GET'))
    expect(get).toContain("getPendingApprovalForDocument(service, 'sow', id)")
    expect(get).toMatch(/pendingApproval: pending \? \{ id: pending\.id, sendFailed: !!pending\.send_failed_at \} : null/)
  })

  it('B4: the SOW editor page locks editing and sending while an approval is open', () => {
    expect(sowPage).toContain('setApproval(json.pendingApproval ?? null)')
    expect(sowPage).toContain('canEdit={!isLocked && !approval && perms.canEdit}')
    expect(sowPage).toContain('canSend={!isLocked && !approval && perms.canSend}')
    expect(sowPage).toMatch(/\{!isLocked && !approval && perms\.canSend && \(/)
    expect(sowPage).toContain('/approvals?highlight=${approval.id}')
  })

  it("B4: ProjectDetail's SOW Edit button is hidden while an approval is open", () => {
    expect(detail).toMatch(/currentSow\.status === 'draft' && permissions\.editSow && !pendingApproval && \(/)
  })
})
