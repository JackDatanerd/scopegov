// Section 13 (Guardian / scope governance) — independent pass 12 fixes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { interpretClassifierOutput } from '@/lib/ai/guardian'

const read = (p: string) => readFileSync(p, 'utf-8')
const bad = (s: string) => /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

describe('B1: inbound email header text is scrubbed before it is stored', () => {
  const src = read('app/api/guardian/inbound/route.ts')
  for (const name of ['toEmail', 'fromEmail', 'fromAddr', 'subject']) {
    it(`${name} goes through stripUnstorableText + truncateText`, () => {
      const line = src.split('\n').find(l => new RegExp(`^\\s*const ${name}\\s*=`).test(l)) || ''
      expect(line).toMatch(/stripUnstorableText/)
      expect(line).toMatch(/truncateText/)
    })
  }
})

describe('verdict text is storable even when the model emits NUL or is cut mid-emoji', () => {
  it('reasoning / matchedReference never contain unstorable characters', () => {
    const raw = JSON.stringify({
      matchedAgainst: 'none', matchConfidence: 0.1, creepConfidence: 0.9,
      matchedReference: 'ref\u0000' + 'a'.repeat(298) + '😀tail',
      reasoning: 'r'.repeat(999) + '😀tail\u0000',
    })
    const v: any = interpretClassifierOutput(raw, { autoFlag: 0.8, borderlineMin: 0.5, hasAmendments: false })
    expect(bad(v.reasoning)).toBe(false)
    expect(bad(v.matchedReference || '')).toBe(false)
    expect(v.reasoning.length).toBeLessThanOrEqual(1000)
    expect((v.matchedReference || '').length).toBeLessThanOrEqual(300)
  })
})
