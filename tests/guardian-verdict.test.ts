import { describe, it, expect } from 'vitest'
import { interpretClassifierOutput, toPlainText, parseVector, cosineSimilarity } from '@/lib/ai/guardian'

const opts = { autoFlag: 0.85, borderlineMin: 0.5, hasAmendments: false }
const reply = (o: Record<string, unknown>) => JSON.stringify(o)

describe('interpretClassifierOutput', () => {
  it('flags a confident out-of-scope verdict', () => {
    const r = interpretClassifierOutput(reply({ matchConfidence: 0.1, creepConfidence: 0.95, matchedAgainst: null, matchedReference: null, reasoning: 'Blog is excluded.' }), opts)
    expect(r.outcome).toBe('out_of_scope')
  })

  // BEFORE: a missing creepConfidence was `|| 0` → "in_scope", no flag, no failure marker.
  it('fails CLOSED when a confidence is missing or garbled (throws so the caller marks classification_failed)', () => {
    expect(() => interpretClassifierOutput(reply({ matchConfidence: 0.1, reasoning: 'x' }), opts)).toThrow(/creepConfidence/)
    expect(() => interpretClassifierOutput(reply({ matchConfidence: 'high', creepConfidence: 0.9 }), opts)).toThrow(/matchConfidence/)
    expect(() => interpretClassifierOutput('not json at all', opts)).toThrow()
    expect(() => interpretClassifierOutput('null', opts)).toThrow()
  })

  it('accepts numeric strings and clamps to 0..1', () => {
    const r = interpretClassifierOutput(reply({ matchConfidence: '0.9', creepConfidence: 7, matchedAgainst: 'sow' }), opts)
    expect(r.matchConfidence).toBe(0.9)
    expect(r.creepConfidence).toBe(1)
  })

  it('recovers JSON wrapped in prose or fences', () => {
    const r = interpretClassifierOutput('Here you go:\n```json\n{"matchConfidence":0.9,"creepConfidence":0.05,"matchedAgainst":"sow","reasoning":"ok"}\n```', opts)
    expect(r.outcome).toBe('in_scope')
  })

  it('sends a contradictory verdict (covered AND creep) to a human instead of resolving it silently', () => {
    const r = interpretClassifierOutput(reply({ matchConfidence: 0.95, creepConfidence: 0.95, matchedAgainst: 'sow' }), opts)
    expect(r.outcome).toBe('borderline')
  })

  it('cannot match an amendment that does not exist', () => {
    const none = interpretClassifierOutput(reply({ matchConfidence: 0.95, creepConfidence: 0.02, matchedAgainst: 'amendment' }), opts)
    expect(none.matchedAgainst).toBe('sow')
    expect(none.outcome).toBe('in_scope')
    const some = interpretClassifierOutput(reply({ matchConfidence: 0.95, creepConfidence: 0.02, matchedAgainst: 'amendment' }), { ...opts, hasAmendments: true })
    expect(some.outcome).toBe('covered_by_co')
  })

  it('is borderline between the thresholds', () => {
    expect(interpretClassifierOutput(reply({ matchConfidence: 0.3, creepConfidence: 0.6 }), opts).outcome).toBe('borderline')
  })
})

// BEFORE: stripHtml's `<[^>]+>` deleted anything between < and > in PLAIN text.
describe('toPlainText', () => {
  it('leaves plain text with comparison operators and <email> addresses intact', () => {
    expect(toPlainText('Please make page load time < 2s and error rate > 1% on checkout')).toBe('Please make page load time < 2s and error rate > 1% on checkout')
    expect(toPlainText('Contact <jane@acme.com> for copy')).toBe('Contact <jane@acme.com> for copy')
    expect(toPlainText('I <3 this')).toBe('I <3 this')
  })
  it('still strips real HTML', () => {
    expect(toPlainText('<div><p>Add a blog</p><p>and SSO &amp; more</p></div>')).toBe('Add a blog\nand SSO & more')
    expect(toPlainText('<style>p{color:red}</style><p>Hello</p>')).toBe('Hello')
  })
})

// BEFORE: pgvector comes back from PostgREST as the text "[0.1,0.2,…]"; comparing it with an array
// returned 0 for every pair, so duplicate detection never matched.
describe('vectors', () => {
  const v = Array.from({ length: 8 }, (_, i) => Math.sin(i + 1))
  it('parses the text literal PostgREST returns', () => {
    expect(parseVector(JSON.stringify(v))).toEqual(v)
    expect(parseVector('garbage')).toBeNull()
    expect(parseVector([1, 'x'])).toBeNull()
  })
  it('cosine works across array / string representations', () => {
    expect(Math.round(cosineSimilarity(v, JSON.stringify(v)) * 1000)).toBe(1000)
    expect(cosineSimilarity(v, 'nope')).toBe(0)
    expect(cosineSimilarity(v, v.slice(1))).toBe(0)
  })
})
