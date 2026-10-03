import { describe, it, expect } from 'vitest'
import { foldedTokens, foldedPhrase, plainPhrase, plainTokens, isSearchable, scoreMatch, rankBy, MAX_QUERY_LENGTH } from '@/lib/search/query'

// Search round 10: three small defects in lib/search/query.ts.

describe('invisible format characters are trimmed from the edges of each word', () => {
  const ZWSP = '\u200B', ZWJ = '\u200D', ZWNJ = '\u200C', LRM = '\u200E', WJ = '\u2060', BOM = '\uFEFF'

  it('a name pasted with a trailing zero-width space still yields the plain token', () => {
    expect(foldedTokens(`Acme${ZWSP}`)).toEqual(['acme'])
    expect(foldedTokens(`${ZWSP}Acme`)).toEqual(['acme'])
    expect(foldedTokens(`${BOM}Acme Corp${LRM}`)).toEqual(['acme', 'corp'])
    expect(foldedTokens(`Acme${WJ} Corp`)).toEqual(['acme', 'corp'])
  })
  it('the whole-phrase helpers agree with the tokens', () => {
    expect(foldedPhrase(`Acme${ZWSP} Corp${ZWSP}`)).toBe('acme corp')
    expect(plainPhrase(`Café${ZWSP} ${LRM}Ünï`)).toBe('café ünï')
    expect(plainTokens(`yum${ZWSP}`)).toEqual(['yum'])
  })
  it('a query made only of invisible characters is not searchable (no database round trip)', () => {
    expect(isSearchable(`${ZWSP}${ZWSP}`)).toBe(false)
    expect(isSearchable(`${ZWSP}a${ZWSP}`)).toBe(false)
    expect(foldedTokens(`${ZWSP} ${BOM}`)).toEqual([])
    expect(isSearchable(`${ZWSP}ab${ZWSP}`)).toBe(true)
  })
  it('keeps joiners INSIDE a word — they are real in Persian / Indic names and stored text keeps them', () => {
    expect(foldedTokens(`a${ZWNJ}b`)).toEqual([`a${ZWNJ}b`])
    expect(foldedTokens(`a${ZWJ}b`)).toEqual([`a${ZWJ}b`])
  })
  it('does not disturb ordinary punctuation or dashes', () => {
    expect(foldedTokens('Acme \u2014 Website')).toEqual(['acme', '-', 'website'])
    expect(foldedTokens('R&D')).toEqual(['r&d'])
  })
})

describe('the length cap cuts by code point, never between surrogates', () => {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  it('an emoji straddling the cap is kept whole or dropped whole', () => {
    const q = 'x'.repeat(MAX_QUERY_LENGTH - 1) + '\u{1F600}y'
    const tokens = foldedTokens(q)
    expect(tokens).toHaveLength(1)
    expect(lone.test(tokens[0])).toBe(false)
    expect(Array.from(tokens[0])).toHaveLength(MAX_QUERY_LENGTH)
    expect(lone.test(foldedPhrase(q))).toBe(false)
    expect(lone.test(plainPhrase(q))).toBe(false)
  })
  it('counts code points, so 100 astral characters are all kept', () => {
    const q = '\u{1F600}'.repeat(MAX_QUERY_LENGTH + 20)
    expect(Array.from(foldedTokens(q)[0])).toHaveLength(MAX_QUERY_LENGTH)
  })
  it('short queries are unchanged', () => {
    expect(foldedTokens('Acme Corp')).toEqual(['acme', 'corp'])
  })
})

describe('scoreMatch gives word-start credit to tokens that contain punctuation', () => {
  it('"r&d" at the start of a word scores like a word-start match', () => {
    expect(scoreMatch('Studio R&D', ['r&d'])).toBe(10)
    expect(scoreMatch('R&D Studio', ['r&d'])).toBe(10 + 40)
  })
  it("\"o'brien\", \"c++\" and \"a.b\" likewise", () => {
    expect(scoreMatch("Studio O'Brien", ["o'brien"])).toBe(10)
    expect(scoreMatch('Team C++ Guild', ['c++'])).toBe(10)
    expect(scoreMatch('Docs a.b Hub', ['a.b'])).toBe(10)
  })
  it('a match in the middle of a word is still only a substring match', () => {
    expect(scoreMatch('Xr&d Co', ['r&d'])).toBe(2)
    expect(scoreMatch('Studio Zobrien', ['obrien'])).toBe(2)
  })
  it('finds a later occurrence when the first one is mid-word', () => {
    expect(scoreMatch('Xr&d r&d', ['r&d'])).toBe(10)
  })
  it('the punctuated name now outranks a mid-word hit', () => {
    const ranked = rankBy(['Xr&d Co', 'Studio R&D'], ['r&d'], s => s)
    expect(ranked[0]).toBe('Studio R&D')
  })
  it('plain tokens are unaffected', () => {
    expect(scoreMatch('Acme Website', ['acme', 'website'])).toBe(scoreMatch('Acme Website', ['acme', 'website'], 'acme website'))
    expect(scoreMatch('Studio Obrien', ['obrien'])).toBe(10)
  })
})
