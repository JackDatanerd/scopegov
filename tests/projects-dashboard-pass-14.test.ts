import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const read = (p: string) => readFileSync(p, 'utf8')

describe('discussion writes are refused on a lapsed (read-only) workspace', () => {
  it('POST /messages checks session.lapsed', () => {
    const s = read('app/api/projects/[id]/messages/route.ts')
    const post = s.slice(s.indexOf('export async function POST'))
    expect(post).toMatch(/session\.lapsed\)\s*return NextResponse\.json\(\{ error: LAPSED_DISCUSSION_ERROR \}, \{ status: 403 \}\)/)
    // GET stays readable
    expect(s.slice(0, s.indexOf('export async function POST'))).not.toMatch(/session\.lapsed/)
  })
  it('PATCH and DELETE on a message check session.lapsed', () => {
    const s = read('app/api/projects/[id]/messages/[messageId]/route.ts')
    expect((s.match(/session\.lapsed/g) || []).length).toBe(2)
  })
  it('the composer and edit/delete actions are hidden when read-only', () => {
    const s = read('components/projects/ProjectDiscussion.tsx')
    expect(s).toMatch(/!readOnly && !m\.deleted/)
    expect(read("components/projects/ProjectDetail.tsx")).toMatch(/readOnly=\{!!session\.lapsed\}/)
  })
})
