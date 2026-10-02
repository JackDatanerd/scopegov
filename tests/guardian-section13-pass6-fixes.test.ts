import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { resolveMatchedAmendmentId } from '@/lib/ai/guardian'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
const amendments = [
  { id: 'a1', title: 'Branding CO', added_deliverables: ['Logo design (3 concepts)'] },
  { id: 'a2', title: 'Web CO', added_deliverables: ['API'] },
]

describe('section 13 pass 6', () => {
  it('P2: a stray token no longer links an unrelated change order', () => {
    expect(resolveMatchedAmendmentId(amendments, 'amendment', 'o')).toBeNull()
    expect(resolveMatchedAmendmentId(amendments, 'amendment', 'api docs portal')).toBeNull()
  })
  it('P2: exact and near-exact matches still resolve', () => {
    expect(resolveMatchedAmendmentId(amendments, 'amendment', 'API')).toBe('a2')
    expect(resolveMatchedAmendmentId(amendments, 'amendment', 'logo design')).toBe('a1')
    expect(resolveMatchedAmendmentId(amendments, 'amendment', 'Branding CO')).toBe('a1')
    expect(resolveMatchedAmendmentId(amendments, 'sow', 'API')).toBeNull()
  })
  it('P1: the sweep excludes manually paused projects in the query and in reclassifyCheck', () => {
    const cron = read('app/api/cron/guardian-health/route.ts')
    expect(cron).toContain("stall_reason.neq.manual")
    expect(cron).toContain("referencedTable: 'projects'")
    expect(cron).toContain('skipManualPause: true')
    const pipe = read('lib/ai/guardian-pipeline.ts')
    expect(pipe).toContain("opts.skipManualPause && project.status === 'Stalled' && project.stall_reason === 'manual'")
    // manual Retry must NOT pass the option
    expect(read('app/api/guardian/checks/[id]/retry/route.ts')).not.toContain('skipManualPause')
  })
  it('P3: draft_co reads the claim error', () => {
    expect(read('app/api/guardian/flags/[id]/route.ts')).toContain("flag claim failed:")
  })
})
