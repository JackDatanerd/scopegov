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
