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

function clean(raw: string): string {
  return String(raw ?? '')
    .slice(0, MAX_QUERY_LENGTH)
    // `*` is a wildcard alias for `%` in PostgREST like/ilike values and
    // there is no way to escape it, so it can't be searched for literally.
    .replace(/\*/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
}

function split(s: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of s.split(/\s+/)) {
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out.slice(0, MAX_TOKENS)
}

/** Accent-folded tokens — for the generated search_text columns. */
export function foldedTokens(raw: string): string[] {
  // `*` is stripped AFTER folding as well as before (clean): unaccent() maps × ⁎ ＊ to a literal `*`, which
  // PostgREST would then read as a `%` wildcard that cannot be escaped.
  return split(normalizeSearchText(clean(raw)).replace(/\*/g, ' '))
}

/** Lower-cased (accents kept) tokens — for plain columns such as titles. */
export function plainTokens(raw: string): string[] {
  return split(clean(raw).toLowerCase().replace(/\s+/g, ' ').trim())
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
export function scoreMatch(text: string, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const t = normalizeSearchText(text)
  const words = t.split(/[\s\-_.,;:!?/\\()[\]{}&'"+#@]+/).filter(Boolean)
  let score = 0
  if (t === tokens.join(' ')) score += 100
  if (t.startsWith(tokens[0])) score += 40
  for (const tok of tokens) {
    if (words.some(w => w.startsWith(tok))) score += 10
    else if (t.includes(tok)) score += 2
  }
  return score
}

/** Stable sort by descending relevance. */
export function rankBy<T>(items: T[], tokens: string[], textOf: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i, s: scoreMatch(textOf(item), tokens) }))
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
