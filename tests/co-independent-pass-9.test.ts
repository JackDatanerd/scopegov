import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { AUDIT_CATEGORIES } from '@/lib/audit/categories'

// CO logic (c10), independent pass 9.
//  CO-1  co_attachment.* / sow_attachment.* audit events matched no audit-log category.
//  CO-2  An edit reverted while an autosave was in flight left the server holding the reverted-away text.
//  CO-3  A refused first send left the address bar on /co/new although the draft already existed.

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const like = (pattern: string, value: string) =>
  new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$').test(value)
const categoryOf = (eventType: string) =>
  AUDIT_CATEGORIES.filter(c => c.patterns.some(p => typeof p === 'string' && like(p, eventType))).map(c => c.id)

describe('CO-1 attachment events land in their document category', () => {
  it.each([
    ['co_attachment.added', 'co'], ['co_attachment.removed', 'co'],
    ['sow_attachment.added', 'sow'], ['sow_attachment.removed', 'sow'],
  ])('%s -> %s only', (evt, cat) => {
    expect(categoryOf(evt)).toEqual([cat])
  })
  it('does not disturb the existing co.% / sow.% matches', () => {
    expect(categoryOf('co.sent')).toEqual(['co'])
    expect(categoryOf('sow.signed')).toEqual(['sow'])
  })
})

describe('CO-2 / CO-3 CoEditor', () => {
  const src = read('components/co/CoEditor.tsx')
  it('re-checks the screen against what a save wrote and re-arms the autosave effect', () => {
    expect(src).toMatch(/snapshotRef\.current = snapshot/)
    expect(src).toMatch(/function reconcileAfterSave\(saved: string\)[\s\S]*?setSaveTick/)
    expect(src).toMatch(/\[snapshot, saveTick,/)
    expect((src.match(/if \(navigate\) reconcileAfterSave\(snapshot\)/g) || []).length).toBe(2)
  })
  it('points the URL at the created CO without remounting when send created it', () => {
    expect(src).toMatch(/else window\.history\.replaceState\(window\.history\.state, '', `\/projects\/\$\{projId\}\/co\/\$\{savedCoId\.current\}`\)/)
  })
})
