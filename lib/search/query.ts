// lib/search/query.ts
//
// Pure helpers for /api/search (kept free of Supabase so they can be unit
// tested).
//
// FIX (Notifications & email / Search fix round): projects and clients were
// searched with to_tsquery('english') prefix terms against a stemmed
// tsvector. Verified against Postgres 16:
//   • "marketing" typed against "Acme Marketing Website" matched at
//     "market", LOST all results at "marketi"/"marketin" (a prefix of a
//     word's *unstemmed* form is not a prefix of its stem), then matched
//     again — results flickered while typing;
//   • O'Brien, R&D, AT&T could not be found (the route stripped ' and & from
//     the query, so "R&D" became "RD:*");
//   • two-letter stop words ("an", "on", "in") matched nothing;
//   • "Cafe" never matched "Café";
//   • a "<" in the query was a tsquery syntax error, silently swallowed.
// They now use the same substring matching as every other block, against a
// generated, accent-folded `search_text` column (migration 062), with the
// query normalised here by the same rules.

import { escapeIlike } from '@/lib/audit/search'
import { UNACCENT } from './unaccent-map'

export const MAX_QUERY_LENGTH = 100
export const MAX_TOKENS = 6
export const MIN_QUERY_LENGTH = 2

/**
 * Fold to the form stored in projects/clients/client_contacts/users.search_text, i.e. what
 * `lower(unaccent(x))` produces in Postgres.
 *
 * FIX (Search section, round 4): this used to be NFD + "strip U+0300–036F" + eight hand-picked letters,
 * which is NOT what unaccent() does — verified by running both over every code point against Postgres 16:
 *   • unaccent() also folds typographic punctuation and compatibility characters that NFD leaves alone
 *     (’ ‘ “ ” – — … ı ĳ ŋ ħ ﬁ ½ © fullwidth forms …), so a query containing one never matched its own
 *     stored text — "O’Brien" (curly apostrophe, what every phone keyboard types) was stored as
 *     o'brien but searched as o’brien, and "Acme — Website" (copied from the palette's own title
 *     format) could never match "acme - website";
 *   • NFD decomposes characters unaccent() leaves intact — every precomposed Hangul syllable and Japanese
 *     kana with a dakuten (が, ぱ …) — so those names, stored whole, were searched as jamo/base+mark and
 *     were unfindable.
 * The fold is now unaccent() itself, per code point (see unaccent-map.ts / scripts/gen-unaccent-map.mjs).
 * Lower-casing is per code point, like Postgres' lower(), so a Greek final sigma is not context-shifted.
 */
export function normalizeSearchText(input: string): string {
  let out = ''
  for (const ch of String(input ?? '')) {
    const cp = ch.codePointAt(0) as number
    out += (cp < 0x80 ? ch : (UNACCENT[cp] ?? ch)).toLowerCase()
  }
  return out.replace(/\s+/g, ' ').trim()
}

// FIX (Search section, round 10): invisible format characters — zero-width space / non-joiner / joiner, LRM/RLM, the bidi
// embedding controls, word joiner and friends, BOM — are not whitespace to JS or to `\s`, so a query pasted from Slack, Notion,
// Google Docs or a PDF ("Acme" + U+200B) became the token "acme\u200b", which no stored name contains: the palette said
// "No results" for a name that was plainly there, and a query made of nothing but these counted as searchable and ran every
// block. They are trimmed from the EDGES of each word only — inside a word U+200C/U+200D are real (Persian/Indic names, emoji
// sequences) and the stored text keeps them, so removing them there would stop a correctly typed name from matching.
const INVISIBLE = '\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF'
const INVISIBLE_EDGE = new RegExp(`^[${INVISIBLE}]+|[${INVISIBLE}]+$`, 'g')
function trimInvisible(word: string): string {
  return word.replace(INVISIBLE_EDGE, '')
}

function clean(raw: string): string {
  // FIX (Search section, round 10): was `.slice(0, MAX_QUERY_LENGTH)` — a UTF-16 cut that, with an emoji or any other
  // astral character straddling position 100, left a lone surrogate (the URL layer turns it into U+FFFD, a token that
  // matches nothing). Cut by code point, like truncateByCodePoint below.
  return Array.from(String(raw ?? '')).slice(0, MAX_QUERY_LENGTH).join('')
    // `*` is a wildcard alias for `%` in PostgREST like/ilike values and
    // there is no way to escape it, so it can't be searched for literally.
    .replace(/\*/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
}

function split(s: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of s.split(/\s+/)) {
    const t = trimInvisible(raw)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out.slice(0, MAX_TOKENS)
}

// FIX (Search section, round 9): `split` de-duplicates (the per-word AND filters gain nothing from "yum AND yum"), but the
// WHOLE-PHRASE the route uses for its exact-name / prefix fetches and the ranker uses for its exact-match bonus was built
// by joining those de-duplicated tokens — so "yum yum" collapsed to "yum", the client called "Yum" outscored the client
// actually named "Yum Yum" (150 vs 50), and the exact-name fetch looked for the wrong string. The phrase keeps repeats.
function splitKeepRepeats(s: string): string[] {
  return s.split(/\s+/).map(trimInvisible).filter(Boolean).slice(0, MAX_TOKENS)
}

/** Accent-folded tokens — for the generated search_text columns. */
export function foldedTokens(raw: string): string[] {
  // `*` is stripped AFTER folding as well as before (clean): unaccent() maps × ⁎ ＊ to a literal `*`, which
  // PostgREST would then read as a `%` wildcard that cannot be escaped.
  return split(normalizeSearchText(clean(raw)).replace(/\*/g, ' '))
}

/** The accent-folded query as typed — repeated words kept (capped at MAX_TOKENS words like the tokens). */
export function foldedPhrase(raw: string): string {
  return splitKeepRepeats(normalizeSearchText(clean(raw)).replace(/\*/g, ' ')).join(' ')
}

/** The lower-cased (accents kept) query as typed — repeated words kept. */
export function plainPhrase(raw: string): string {
  return splitKeepRepeats(clean(raw).toLowerCase()).join(' ')
}

/** Lower-cased (accents kept) tokens — for plain columns such as titles. */
export function plainTokens(raw: string): string[] {
  return split(clean(raw).toLowerCase().replace(/\s+/g, ' ').trim())
}

// Cut by code point, not UTF-16 unit: String.slice(0, 80) can end between the two halves of an emoji (or any
// astral character), leaving a lone surrogate that renders as a broken-character box in the palette.
export function truncateByCodePoint(text: string, max: number): string {
  const chars = Array.from(String(text ?? ''))
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('')
}

/** `%term%` with LIKE metacharacters escaped so what was typed matches literally. */
export function likePattern(token: string): string {
  return `%${escapeIlike(token)}%`
}

/** `term%` — anchors at the start, so names that BEGIN with what was typed are always fetched. */
export function prefixLike(text: string): string {
  return `${escapeIlike(text)}%`
}

export function isSearchable(raw: string | null | undefined): boolean {
  // Via foldedTokens so the length is that of what will actually be searched (a query made only of
  // × or * folds to nothing and must not count as searchable).
  return foldedTokens(raw ?? '').join(' ').length >= MIN_QUERY_LENGTH
}

/**
 * Relevance of `text` for the query tokens (higher is better). Used to order
 * the few rows each block fetches, since a bare LIMIT returned an arbitrary
 * subset.
 */
export function scoreMatch(text: string, tokens: string[], phrase: string = tokens.join(' ')): number {
  if (tokens.length === 0) return 0
  const t = normalizeSearchText(text)
  const words = t.split(/[\s\-_.,;:!?/\\()[\]{}&'"+#@]+/).filter(Boolean)
  let score = 0
  if (t === phrase) score += 100
  if (t.startsWith(tokens[0])) score += 40
  for (const tok of tokens) {
    if (words.some(w => w.startsWith(tok)) || startsAtBoundary(t, tok)) score += 10
    else if (t.includes(tok)) score += 2
  }
  return score
}

// FIX (Search section, round 10): `words` is split on & ' + # @ . - etc., so a token that itself contains one of them
// (r&d, o'brien, c++, a.b) can never be a prefix of any word — "Studio R&D" scored 2 for `r&d` (substring) while
// "Studio Obrien" scored 10 for `obrien`, ranking the punctuation-free name above the one actually typed. A token also counts
// as word-initial when it occurs at the start of the text or right after a separator.
const BOUNDARY = /[\s\-_.,;:!?/\\()[\]{}&'"+#@]/
function startsAtBoundary(text: string, tok: string): boolean {
  for (let i = text.indexOf(tok); i !== -1; i = text.indexOf(tok, i + 1)) {
    if (i === 0 || BOUNDARY.test(text[i - 1])) return true
  }
  return false
}

/** Stable sort by descending relevance. */
export function rankBy<T>(items: T[], tokens: string[], textOf: (item: T) => string, phrase?: string): T[] {
  return items
    .map((item, i) => ({ item, i, s: scoreMatch(textOf(item), tokens, phrase) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(x => x.item)
}

// ── Light per-user throttle ───────────────────────────────────────────────
// Each keystroke-debounced request fans out to ~10 queries. This is a
// per-instance sliding window (serverless instances don't share memory), so
// it is an abuse dampener, not a hard guarantee.
const hits = new Map<string, number[]>()
export function searchRateLimited(key: string, now = Date.now(), limit = 120, windowMs = 60_000): boolean {
  const recent = (hits.get(key) || []).filter(t => now - t < windowMs)
  if (recent.length >= limit) { hits.set(key, recent); return true }
  recent.push(now)
  hits.set(key, recent)
  if (hits.size > 5000) {
    hits.forEach((v, k) => { if (v.every(t => now - t >= windowMs)) hits.delete(k) })
  }
  return false
}
