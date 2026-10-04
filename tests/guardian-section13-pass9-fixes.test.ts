// Section 13 (Guardian / scope governance) — independent pass 9 fixes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { canViewGovernance, GOVERNANCE_VIEW_PERMISSIONS } from '@/lib/utils/flag-governance'

const session = (permissions: string[]) => ({ permissions } as any)
const read = (p: string) => readFileSync(p, 'utf-8')

describe('B3: notes/evidence reads need a Guardian view permission', () => {
  it('allows each of the four sibling-route permissions', () => {
    for (const p of GOVERNANCE_VIEW_PERMISSIONS) expect(canViewGovernance(session([p]))).toBe(true)
  })
  it('refuses a session holding none of them', () => {
    expect(canViewGovernance(session(['VIEW_ALL_PROJECTS', 'SUBMIT_GUARDIAN_CHECKS']))).toBe(false)
    expect(canViewGovernance(session([]))).toBe(false)
  })
  it('matches the list used by the sibling source-view routes', () => {
    const sibling = read('app/api/guardian/checks/[id]/attachments/route.ts')
    for (const p of GOVERNANCE_VIEW_PERMISSIONS) expect(sibling).toContain(`'${p}'`)
  })
  it('both GET handlers call the guard before touching data', () => {
    for (const f of ['comments', 'attachments']) {
      const src = read(`app/api/scope-governance/[entityType]/[entityId]/${f}/route.ts`)
      const get = src.slice(src.indexOf('export async function GET'), src.indexOf('export async function POST'))
      expect(get).toContain('canViewGovernance(session)')
      expect(get.indexOf('canViewGovernance(session)')).toBeLessThan(get.indexOf('resolveEntity('))
    }
  })
})

describe('B2: no-SOW queue is bounded', () => {
  it('check route caps manually queued checks before inserting a pending row', () => {
    const src = read('app/api/guardian/check/route.ts')
    const branch = src.slice(src.indexOf('if (!snapshot) {'), src.indexOf('const limited = await claimAiRateSlot'))
    expect(branch).toContain('MAX_QUEUED_PER_PROJECT')
    expect(branch).toContain('status: 429')
    expect(branch.indexOf('MAX_QUEUED_PER_PROJECT')).toBeLessThan(branch.indexOf(".insert({"))
  })
})

describe('B1: FlagCollaboration surfaces read failures', () => {
  it('checks res.ok and renders the error outside the loaded branch', () => {
    const src = read('components/projects/FlagCollaboration.tsx')
    expect(src).toContain('!cRes.ok || !aRes.ok')
    expect(src).toContain('loadFailed')
    expect(src).toContain('Retry')
  })
})
