import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', workspaceId: 'w1', permissions: [] }),
  hasPermission: () => true,
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { throw new Error('db must not be reached for a malformed id') },
}))
vi.mock('@/lib/pdf/renderer', () => ({ renderSowPdf: vi.fn(), resolveLogoDataUri: vi.fn() }))

const read = (p: string) => readFileSync(p, 'utf8')
const BAD = { params: Promise.resolve({ id: 'not-a-uuid' }) }

describe('SOW lifecycle pass 16', () => {
  it('B2: PDF route answers a malformed id with 404 before touching the database', async () => {
    const { GET } = await import('@/app/api/pdf/sow/[id]/route')
    const res = await GET(new Request('http://x') as any, BAD as any)
    expect(res.status).toBe(404)
  })

  it('B2: regenerate-section answers a malformed sowId with 404', async () => {
    const { POST } = await import('@/app/api/sow/regenerate-section/route')
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ sowId: 'nope', sectionId: 'overview' }) })
    const res = await POST(req as any)
    expect(res.status).toBe(404)
  })

  it('B1: the registry surfaces failed list and count queries', () => {
    const src = read('app/(app)/sow/page.tsx')
    expect(src).toMatch(/totalErr/)
    expect(src).toMatch(/loadFailed/)
    expect(src).toMatch(/sowErr && !safeSows\.length \? null/)
  })

  it('B3: the attachments list reads its error and the panel reports a failed load', () => {
    expect(read('app/api/sow/[id]/attachments/route.ts')).toMatch(/attachmentsErr/)
    expect(read('components/sow/SowEditor.tsx')).toMatch(/Could not load attachments/)
  })

  it('B4: GET /api/sow/[id] logs what it swallows', () => {
    expect(read('app/api/sow/[id]/route.ts')).toMatch(/console\.error\('SOW GET error:'/)
  })
})
