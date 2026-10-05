import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { glob } from 'node:fs/promises'

const read = (p: string) => readFileSync(p, 'utf8')

// Pass 11, B1: a malformed project / message / client id reached Postgres as `uuid = 'abc'` (22P02), which the
// pass-10 "a failed read is a 500" handling turned into a 500 (API) or the error boundary (project page).
// Every route under api/projects/[id] must reject a non-UUID id with a 404 before it queries.
describe('malformed ids are 404, not 500 (pass 11, B1)', () => {
  it('every api/projects/[id]/** route handler checks the URL id with isUuidString', async () => {
    const files: string[] = []
    for await (const f of glob('app/api/projects/[[]id]/**/route.ts')) files.push(f)
    for await (const f of glob('app/api/projects/[[]id]/route.ts')) files.push(f)
    const unique = Array.from(new Set(files))
    expect(unique.length).toBeGreaterThanOrEqual(13)
    for (const f of unique) {
      const src = read(f)
      const handlers = (src.match(/export async function (GET|POST|PATCH|DELETE)\b/g) || []).length
      const guards = (src.match(/if \(!isUuidString\((id|projectId)\)/g) || []).length
      expect(guards, `${f}: ${guards} guards for ${handlers} handlers`).toBeGreaterThanOrEqual(handlers)
    }
  })

  it('the message routes also check messageId', () => {
    const src = read('app/api/projects/[id]/messages/[messageId]/route.ts')
    expect((src.match(/isUuidString\(messageId\)/g) || []).length).toBe(2)
  })

  it('a non-UUID clientId is "Client not found" in POST and PATCH, not a lookup 500', () => {
    expect(read('app/api/projects/route.ts')).toContain("if (!isUuidString(clientId)) return NextResponse.json({ error: 'Client not found' }")
    expect(read('app/api/projects/[id]/route.ts')).toContain('if (!isUuidString(body.clientId))')
  })

  it('the project page 404s (and does not title) a non-UUID id', () => {
    const src = read('app/(app)/projects/[id]/page.tsx')
    expect(src).toContain('if (!isUuidString(id)) notFound()')
    expect(src).toContain("if (!isUuidString(id)) return { title: 'Project' }")
  })

  // Traced out of section 7: the same unguarded-id shape in the routes the project page calls into.
  it('co / sow / invoices / approvals [id] routes guard every URL id too', async () => {
    const files: string[] = []
    for (const dir of ['co', 'sow', 'invoices', 'approvals'])
      for await (const f of glob(`app/api/${dir}/**/route.ts`)) files.push(f)
    let checked = 0
    for (const f of files) {
      const src = read(f)
      if (!src.includes('await params')) continue
      checked++
      const handlers = (src.match(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g) || []).length
      const guards = (src.match(/if \(!isUuidString\(/g) || []).length
      expect(guards, `${f}: ${guards} guards for ${handlers} handlers`).toBeGreaterThanOrEqual(handlers)
    }
    expect(checked).toBeGreaterThanOrEqual(30)
  })
})
