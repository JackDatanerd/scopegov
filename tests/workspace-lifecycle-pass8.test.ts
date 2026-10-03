import { describe, it, expect, vi } from 'vitest'

// Workspace lifecycle independent pass 8.
// B1: sanitizeDisplayName let an unpaired surrogate through unless it sat at the very end of the length cut,
//     so Postgres rejected the JSON and workspace/create + workspace/profile answered 500 instead of 400.
// B2: POST /api/workspace/profile/avatar looked the declared file type up in a plain object, so '__proto__'
//     matched, then threw in the magic-byte step (500 instead of 400).

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { throw new Error('storage/db must not be reached for a rejected file type') },
}))
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ id: 'u1', email: 'u@example.com', name: 'U', workspaceId: 'w1' }),
}))

describe('sanitizeDisplayName — unpaired surrogates (B1)', () => {
  it('removes a lone high surrogate in the middle of a name', async () => {
    const { sanitizeDisplayName } = await import('@/lib/utils/sanitize')
    const out = sanitizeDisplayName('Acme\uD800 Studio')
    expect(out).toBe('Acme Studio')
    expect(out.isWellFormed()).toBe(true)
  })

  it('removes a lone low surrogate at the start of a name', async () => {
    const { sanitizeDisplayName } = await import('@/lib/utils/sanitize')
    expect(sanitizeDisplayName('\uDC00Acme')).toBe('Acme')
  })

  it('a name made only of lone surrogates is empty, so callers answer 400', async () => {
    const { sanitizeDisplayName } = await import('@/lib/utils/sanitize')
    expect(sanitizeDisplayName('\uD800')).toBe('')
    expect(sanitizeDisplayName('\uD800\uD800 \uDC00')).toBe('')
  })

  it('keeps valid surrogate pairs (real emoji) intact', async () => {
    const { sanitizeDisplayName } = await import('@/lib/utils/sanitize')
    expect(sanitizeDisplayName('Acme \u{1F600} Co')).toBe('Acme \u{1F600} Co')
  })

  it('still does not split an emoji at the length cap', async () => {
    const { sanitizeDisplayName } = await import('@/lib/utils/sanitize')
    const out = sanitizeDisplayName('x'.repeat(119) + '\u{1F600}')
    expect(out).toBe('x'.repeat(119))
    expect(out.isWellFormed()).toBe(true)
  })
})

describe('POST /api/workspace/profile/avatar — inherited type keys (B2)', () => {
  const upload = (type: string) => {
    const fd = new FormData()
    fd.append('file', new File([new Uint8Array([1, 2, 3])], 'a.png', { type }))
    return new Request('http://localhost/api/workspace/profile/avatar', { method: 'POST', body: fd })
  }

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('declared type %s is a 400, not a 500', async (type) => {
    const { POST } = await import('@/app/api/workspace/profile/avatar/route')
    const res = await POST(upload(type) as any)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/PNG or JPG/)
  })
})
