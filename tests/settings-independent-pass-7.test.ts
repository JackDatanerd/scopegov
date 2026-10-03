import { describe, it, expect } from 'vitest'
import { staleWorkspaceResponse } from '@/lib/utils/workspace-guard'
import { diffFields } from '@/lib/utils/audit-diff'
import { readFileSync } from 'fs'

describe('Settings independent pass 7', () => {
  it('stale-tab guard: passes when absent, blank or matching; 409 when it names another workspace', async () => {
    expect(staleWorkspaceResponse(undefined, 'ws-1')).toBeNull()
    expect(staleWorkspaceResponse(null, 'ws-1')).toBeNull()
    expect(staleWorkspaceResponse('', 'ws-1')).toBeNull()
    expect(staleWorkspaceResponse('ws-1', 'ws-1')).toBeNull()
    const res = staleWorkspaceResponse('ws-2', 'ws-1')
    expect(res?.status).toBe(409)
  })

  it('every Settings write route calls the guard', () => {
    for (const f of [
      'app/api/workspace/numbering/route.ts',
      'app/api/workspace/notification-defaults/route.ts',
      'app/api/approval-workflows/route.ts',
      'app/api/workspace/defaults/route.ts',
    ]) expect(readFileSync(f, 'utf8')).toContain('staleWorkspaceResponse(')
  })

  it('replyToEmail is recorded as changed without its value', () => {
    const src = readFileSync('app/api/workspace/settings/route.ts', 'utf8')
    const list = /const AUDIT_REDACT = \[([^\]]*)\]/.exec(src)![1]
    expect(list).toContain("'replyToEmail'")
    const { changes } = diffFields({ replyToEmail: null }, { replyToEmail: 'a@b.co' }, ['replyToEmail'])
    expect(changes.replyToEmail).toEqual({ changed: true })
  })
})
