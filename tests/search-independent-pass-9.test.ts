import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { foldedTokens, foldedPhrase, plainPhrase, scoreMatch, rankBy, isSearchable } from '@/lib/search/query'

// Search round 9: the whole-phrase used for the exact-name/prefix fetches and the exact-match rank bonus was built from
// the DE-DUPLICATED tokens, so a repeated word collapsed ("yum yum" -> "yum").
describe('foldedPhrase / plainPhrase keep repeated words', () => {
  it('keeps repeats the tokens drop', () => {
    expect(foldedTokens('yum yum')).toEqual(['yum'])
    expect(foldedPhrase('yum yum')).toBe('yum yum')
    expect(plainPhrase('Bora  BORA')).toBe('bora bora')
  })
  it('folds accents (folded) and keeps them (plain), like the tokens', () => {
    expect(foldedPhrase('Café café')).toBe('cafe cafe')
    expect(plainPhrase('Café café')).toBe('café café')
  })
  it('is identical to the tokens joined when nothing repeats', () => {
    for (const q of ['Acme Website', 'AT&T Rebrand', "O\u2019Brien  Co", 'a b c']) {
      expect(foldedPhrase(q)).toBe(foldedTokens(q).join(' '))
    }
  })
  it('strips * and control characters, and is capped at 6 words like the tokens', () => {
    expect(foldedPhrase('x*y\tz')).toBe('x y z')
    expect(foldedPhrase('a1 a1 a1 a1 a1 a1 a1 a1').split(' ')).toHaveLength(6)
  })
  it('does not change what is searchable', () => {
    expect(isSearchable('a a')).toBe(false)
  })
})

describe('ranking uses the phrase for the exact-match bonus', () => {
  const names = ['Yum Yum Bakery', 'Yum', 'Yum Yum']
  it('without the phrase the wrong row wins (the bug)', () => {
    expect(rankBy(names, foldedTokens('yum yum'), x => x)[0]).toBe('Yum')
  })
  it('with the phrase the exact name comes first', () => {
    expect(rankBy(names, foldedTokens('yum yum'), x => x, foldedPhrase('yum yum'))[0]).toBe('Yum Yum')
  })
  it('scoreMatch defaults the phrase to the joined tokens (old behaviour for non-repeating queries)', () => {
    expect(scoreMatch('Acme Web', ['acme', 'web'])).toBe(scoreMatch('Acme Web', ['acme', 'web'], 'acme web'))
    expect(scoreMatch('Acme Web', ['acme', 'web'])).toBeGreaterThanOrEqual(100)
  })
})

describe('the route builds its whole-phrase strings from the phrase helpers', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/search/route.ts'), 'utf8')
  it('wholeFolded / wholePlain keep repeats', () => {
    expect(src).toContain('const wholeFolded = foldedPhrase(q)')
    expect(src).toContain('const wholePlain = plainPhrase(q)')
    expect(src).not.toMatch(/folded\.join\(' '\)|plain\.join\(' '\)/)
  })
  it('every rankBy call passes the phrase', () => {
    const calls = src.match(/rankBy\(/g) || []
    const withPhrase = src.match(/rankBy\([^\n]*wholeFolded\)/g) || []
    expect(calls.length).toBeGreaterThan(0)
    expect(withPhrase.length).toBe(calls.length)
  })
})
