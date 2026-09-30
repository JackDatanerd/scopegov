import { describe, it, expect, vi, beforeEach } from 'vitest'

// FIX (section-9 independent pass): two bugs in the SOW attachment routes.
//  1. DELETE removed the Storage object unconditionally, but reopen / portal request-changes copy
//     attachment rows onto a new SOW version sharing the SAME storage_path — deleting from the new
//     draft silently broke the file behind the superseded version's row.
//  2. POST enforced the 20-attachment cap and the draft-only lock with read-then-insert checks;
//     the insert now goes through sow_attachment_add (migration 109) which rechecks under a lock.

const h = vi.hoisted(() => ({
  session: null as any,
  sow: null as any,
  attachment: null as any,
  remaining: 0 as number,
  refError: null as any,
  rpcResult: { data: null as any, error: null as any },
  rpcCalls: [] as any[],
  removed: [] as string[][],
  uploaded: [] as string[],
  fromCalls: [] as string[],
}))

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => h.session,
  hasPermission: (s: any, p: string) => (s?.permissions || []).includes(p),
}))
// The routes also refuse while an approval request is outstanding (section-11 B1); no request here.
vi.mock('@/lib/approvals/engine', () => ({ getPendingApprovalForDocument: async () => null }))
vi.mock('@/lib/utils/project-access', () => ({ canReadProject: async () => true }))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/utils/audit', () => ({ logAudit: async () => true }))
vi.mock('@/lib/utils/file-signature', () => ({
  ALLOWED_ATTACHMENT_TYPES: new Set(['application/pdf']),
  matchesDeclaredType: () => true,
  resolveAttachmentType: (_name: string, declared: string) => declared,
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      h.fromCalls.push(table)
      let mode: 'select' | 'delete' = 'select'
      let head = false
      let filters: Record<string, any> = {}
      const b: any = {
        select: (_c?: string, opts?: any) => { head = !!opts?.head; return b },
        delete: () => { mode = 'delete'; return b },
        eq: (k: string, v: any) => { filters[k] = v; return b },
        order: () => b,
        single: async () => {
          if (table === 'sow_documents') return { data: h.sow, error: null }
          return { data: h.attachment, error: null }
        },
        then: (res: any) => {
          if (mode === 'delete') return res({ data: null, error: null })
          if (head && 'storage_path' in filters) return res({ count: h.remaining, error: h.refError })
          if (head) return res({ count: h.remaining, error: null })
          return res({ data: [], error: null })
        },
      }
      return b
    },
    rpc: async (name: string, args: any) => { h.rpcCalls.push({ name, args }); return h.rpcResult },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => { h.removed.push(paths); return { error: null } },
        upload: async (p: string) => { h.uploaded.push(p); return { error: null } },
        createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.test/x' } }),
      }),
    },
  }),
}))

import { DELETE } from '@/app/api/sow/[id]/attachments/[attachmentId]/route'
import { POST } from '@/app/api/sow/[id]/attachments/route'

beforeEach(() => {
  h.session = { id: 'u1', email: 'a@b.co', name: 'A', workspaceId: 'w1', permissions: ['EDIT_SOW'] }
  h.sow = { id: 's2', project_id: 'p1', sent_at: null }
  h.attachment = { id: 'a1', storage_path: 'w1/sow/s1/abc.pdf', file_name: 'brief.pdf' }
  h.remaining = 0
  h.refError = null
  h.rpcResult = { data: { id: 'new1', uploaded_at: '2026-09-29T00:00:00Z' }, error: null }
  h.rpcCalls.length = 0; h.removed.length = 0; h.uploaded.length = 0; h.fromCalls.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const del = () => DELETE({ headers: new Headers() } as any, { params: Promise.resolve({ id: 's2', attachmentId: 'a1' }) })

describe('DELETE /api/sow/[id]/attachments/[attachmentId] — shared storage objects', () => {
  it('removes the Storage object when no other row references it', async () => {
    h.remaining = 0
    const res = await del()
    expect(res.status).toBe(200)
    expect(h.removed).toEqual([['w1/sow/s1/abc.pdf']])
  })

  it('KEEPS the Storage object when a superseded version still references the same path', async () => {
    h.remaining = 1
    const res = await del()
    expect(res.status).toBe(200)
    expect(h.removed).toHaveLength(0)
  })

  it('keeps the object (orphan beats dangling reference) when the reference lookup fails', async () => {
    h.remaining = 0
    h.refError = { message: 'boom' }
    const res = await del()
    expect(res.status).toBe(200)
    expect(h.removed).toHaveLength(0)
  })

  it('still refuses to delete from a locked SOW', async () => {
    h.sow = { id: 's2', project_id: 'p1', sent_at: '2026-01-01' }
    const res = await del()
    expect(res.status).toBe(409)
    expect(h.removed).toHaveLength(0)
  })
})

function postReq() {
  const fd = new FormData()
  fd.set('file', new File([new Uint8Array([37, 80, 68, 70])], 'brief.pdf', { type: 'application/pdf' }))
  return { headers: new Headers(), formData: async () => fd } as any
}
const post = () => POST(postReq(), { params: Promise.resolve({ id: 's2' }) })

describe('POST /api/sow/[id]/attachments — cap and lock enforced atomically', () => {
  it('inserts through the sow_attachment_add RPC, not a bare insert', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(h.rpcCalls).toHaveLength(1)
    expect(h.rpcCalls[0].name).toBe('sow_attachment_add')
    expect(h.rpcCalls[0].args).toMatchObject({ p_sow_id: 's2', p_file_name: 'brief.pdf', p_uploaded_by: 'u1' })
    const json = await res.json()
    expect(json.attachment).toMatchObject({ id: 'new1', fileName: 'brief.pdf' })
  })

  it('a cap hit reported by the RPC (lost race) is a 400 and the uploaded object is rolled back', async () => {
    h.rpcResult = { data: null, error: { message: 'attachment_limit_exceeded' } }
    const res = await post()
    expect(res.status).toBe(400)
    expect(h.removed).toEqual([h.uploaded])
  })

  it('a lock reported by the RPC (upload racing a send) is a 409 and the object is rolled back', async () => {
    h.rpcResult = { data: null, error: { message: 'sow_locked' } }
    const res = await post()
    expect(res.status).toBe(409)
    expect(h.removed).toEqual([h.uploaded])
  })

  it('an unexpected RPC failure is a 500 and still rolls the object back', async () => {
    h.rpcResult = { data: null, error: { message: 'connection reset' } }
    const res = await post()
    expect(res.status).toBe(500)
    expect(h.removed).toEqual([h.uploaded])
  })
})
