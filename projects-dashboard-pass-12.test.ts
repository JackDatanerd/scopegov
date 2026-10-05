import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8')

// Pass 12, B1: a gateway error (502/504 HTML or plain-text body — the AI calls run up to 120s) made a bare
// `await res.json()` throw a SyntaxError whose raw text was shown to the person; and `throw new Error(json.error)`
// with no fallback produced an EMPTY message (nothing shown). Every fetch in these two files must parse defensively.
describe('project UI parses error bodies defensively (pass 12, B1)', () => {
  for (const f of ['components/projects/ProjectDetail.tsx', 'app/(app)/projects/new/page.tsx']) {
    it(`${f}: no bare res.json() and no error thrown without fallback text`, () => {
      const src = read(f)
      expect(src.match(/await res\.json\(\)\s*$/gm) || []).toEqual([])
      expect(src.match(/throw new Error\(json\.error\)/g) || []).toEqual([])
    })
  }

  it('SOW generation names the timeout case instead of a generic failure', () => {
    expect(read('components/projects/ProjectDetail.tsx')).toContain('res.status >= 502')
    expect(read('app/(app)/projects/new/page.tsx')).toContain('res.status >= 502')
  })

  it('a 200 without the id the caller navigates with is an error, not a push to undefined', () => {
    expect(read('app/(app)/projects/new/page.tsx')).toContain('!res.ok || !json.projectId')
    expect(read('components/projects/ProjectDetail.tsx')).toContain('!res.ok || !json.sowId')
  })
})

// Pass 12, B2: a project stalled because its SOW was never signed has no signed scope. The Guardian tab called it
// "paused" and offered live checks "against the signed scope" while the Overview tab said "Not yet active".
describe('Guardian tab: SOW-unsigned stall is not "paused" (pass 12, B2)', () => {
  const src = read('components/projects/ProjectDetail.tsx')
  it('derives unsignedStall and removes live checking for it', () => {
    expect(src).toContain("project.stall_reason === 'sow_unsigned'")
    expect(src).toContain("['Active', 'Stalled'].includes(project.status) && !unsignedStall")
    expect(src).toContain("project.status === 'Stalled' && !unsignedStall ? 'Guardian paused'")
  })
})
