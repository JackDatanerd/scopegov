import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('notifications & email pass 20', () => {
  it('guardian flag escalate checks assignee project access strictly (read failure => 500, not a false "no access" 400)', () => {
    const src = read('app/api/guardian/flags/[id]/route.ts')
    const start = src.indexOf('filterToProjectAccess(\n')
    expect(start).toBeGreaterThan(-1)
    const call = src.slice(start, start + 600)
    expect(call).toMatch(/\{ strict: true \}/)
  })

  it('the CO escalate route keeps the same strict check', () => {
    const src = read('app/api/co/[id]/escalate/route.ts')
    const start = src.indexOf('filterToProjectAccess(\n')
    expect(src.slice(start, start + 600)).toMatch(/\{ strict: true \}/)
  })
})
