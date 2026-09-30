import { describe, it, expect } from 'vitest'
import {
  normalizeSearchText, foldedTokens, plainTokens, likePattern, isSearchable,
  scoreMatch, rankBy, searchRateLimited,
} from '@/lib/search/query'

describe('normalizeSearchText — must match projects/clients.search_text (migration 062)', () => {
  it('folds accents and case like unaccent(lower())', () => {
    expect(normalizeSearchText('Café Nero')).toBe('cafe nero')
    expect(normalizeSearchText('José Müller')).toBe('jose muller')
  })
  it('folds the letters NFD does not decompose (same as Postgres unaccent)', () => {
    expect(normalizeSearchText('Ørsted')).toBe('orsted')
    expect(normalizeSearchText('Straße')).toBe('strasse')
    expect(normalizeSearchText('Æther')).toBe('aether')
    expect(normalizeSearchText('Łódź')).toBe('lodz')
  })
  it('keeps apostrophes and ampersands — the old tsquery route stripped them so O\'Brien and R&D were unfindable', () => {
    expect(normalizeSearchText("O'Brien")).toBe("o'brien")
    expect(normalizeSearchText('R&D')).toBe('r&d')
    expect(foldedTokens("O'Brien")).toEqual(["o'brien"])
    expect(foldedTokens('AT&T Rebrand')).toEqual(['at&t', 'rebrand'])
  })
})

describe('normalizeSearchText — folds what Postgres unaccent() folds (Search round 4)', () => {
  it('folds curly apostrophes and quotes — what phone keyboards type for O\u2019Brien', () => {
    expect(normalizeSearchText('O\u2019Brien')).toBe("o'brien")
    expect(normalizeSearchText('\u2018Acme\u2019')).toBe("'acme'")
    expect(normalizeSearchText('\u201CAcme\u201D')).toBe('"acme"')
    expect(foldedTokens('O\u2019Brien')).toEqual(["o'brien"])
  })
  it('folds en/em dashes and the ellipsis — the palette shows "name \u2014 disc", people copy it', () => {
    expect(foldedTokens('Acme \u2014 Website')).toEqual(['acme', '-', 'website'])
    expect(normalizeSearchText('Acme \u2013 Website')).toBe('acme - website')
    expect(normalizeSearchText('Wait\u2026')).toBe('wait...')
  })
  it('folds compatibility letters and ligatures', () => {
    expect(normalizeSearchText('K\u0131l\u0131\u00E7')).toBe('kilic')   // dotless i
    expect(normalizeSearchText('\uFB01nance')).toBe('finance')            // \uFB01 ligature
    expect(normalizeSearchText('\u0133')).toBe('ij')
    expect(normalizeSearchText('\uFF21\uFF43\uFF4D\uFF45')).toBe('acme')  // fullwidth
    expect(normalizeSearchText('\u00BD')).toBe('1/2')
  })
  it('does NOT decompose characters unaccent() leaves whole (Hangul, kana with dakuten)', () => {
    expect(normalizeSearchText('\uD55C\uAD6D')).toBe('\uD55C\uAD6D')
    expect(normalizeSearchText('\u304C')).toBe('\u304C')
    expect(normalizeSearchText('\u3071')).toBe('\u3071')
  })
  it('still folds accents in precomposed AND decomposed form', () => {
    expect(normalizeSearchText('Caf\u00E9')).toBe('cafe')
    expect(normalizeSearchText('Cafe\u0301')).toBe('cafe')
    expect(normalizeSearchText('\u1EC7')).toBe('e')
  })
  it('maps every kind of space to a single space', () => {
    expect(normalizeSearchText('a\u00A0\u2003b\u3000c')).toBe('a b c')
  })
  it('folds astral characters by code point without splitting surrogates', () => {
    expect(normalizeSearchText('\uD83C\uDD10x')).toBe('(a)x')            // U+1F110 parenthesized A
    expect(normalizeSearchText('\uD835\uDC00')).toBe('\uD835\uDC00')     // unaccent() leaves U+1D400 alone and it has no lower-case form
  })
  it('a fold that produces "*" can never reach PostgREST as a wildcard', () => {
    expect(foldedTokens('\u00D7')).toEqual([])
    expect(foldedTokens('a\u00D7b')).toEqual(['a', 'b'])
    expect(isSearchable('\u00D7\u00D7')).toBe(false)
    expect(likePattern(foldedTokens('50\uFF05')[0])).toBe('%50\\%%')       // fullwidth % folds to % and is then escaped
  })
})

describe('tokens', () => {
  it('splits on whitespace, dedupes, caps at 6', () => {
    expect(foldedTokens('acme  acme website')).toEqual(['acme', 'website'])
    expect(foldedTokens('a b c d e f g h')).toHaveLength(6)
  })
  it('drops "*" (a PostgREST wildcard that cannot be escaped) and control characters', () => {
    expect(foldedTokens('**')).toEqual([])
    expect(foldedTokens('ac*me')).toEqual(['ac', 'me'])
    expect(foldedTokens('a\u0000b')).toEqual(['a', 'b'])
  })
  it('plainTokens keeps accents (titles are not folded in the DB)', () => {
    expect(plainTokens('Café Redesign')).toEqual(['café', 'redesign'])
  })
  it('does not treat two-letter stop words specially ("an", "on", "in" matched nothing under tsquery)', () => {
    expect(foldedTokens('on')).toEqual(['on'])
    expect(isSearchable('on')).toBe(true)
  })
  it('isSearchable enforces the 2-char minimum after normalisation', () => {
    expect(isSearchable('a')).toBe(false)
    expect(isSearchable(' a ')).toBe(false)
    expect(isSearchable('')).toBe(false)
    expect(isSearchable(null)).toBe(false)
    expect(isSearchable('**')).toBe(false)
  })
})

describe('likePattern', () => {
  it('escapes LIKE metacharacters so they match literally', () => {
    expect(likePattern('100%')).toBe('%100\\%%')
    expect(likePattern('a_b')).toBe('%a\\_b%')
    expect(likePattern('a\\b')).toBe('%a\\\\b%')
  })
})

describe('ranking', () => {
  const items = ['Big Marketing Push', 'Marketing', 'Acme Marketing Website', 'Remarketing Plan']
  it('exact > starts-with > word-start > contains', () => {
    const ranked = rankBy(items, ['marketing'], s => s)
    expect(ranked[0]).toBe('Marketing')
    expect(ranked[ranked.length - 1]).toBe('Remarketing Plan')
  })
  it('is stable for equal scores', () => {
    const r = rankBy(['x a', 'y a', 'z a'], ['a'], s => s)
    expect(r).toEqual(['x a', 'y a', 'z a'])
  })
  it('scoreMatch handles empty tokens', () => {
    expect(scoreMatch('anything', [])).toBe(0)
  })
})

describe('searchRateLimited', () => {
  it('allows up to the limit inside the window then blocks, and recovers', () => {
    const key = 'user-' + Math.random()
    for (let i = 0; i < 120; i++) expect(searchRateLimited(key, 1000)).toBe(false)
    expect(searchRateLimited(key, 1000)).toBe(true)
    expect(searchRateLimited(key, 1000 + 61_000)).toBe(false)
  })
})
