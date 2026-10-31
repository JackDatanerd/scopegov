// lib/help/search.ts
//
// Search over the help articles, run in the browser on the /help home page. Pure functions only (no React, no registry import), so it
// is cheap to ship to the client and easy to test. The index holds plain text, with the **bold** and [link](/path) markup stripped.
//
// What is searched, strongest first: the title, the "symptoms" (written in the reader's own words, so "can't find the Send button" finds
// the right article), the summary, the step titles, the short answer, and the category name.
//
// Matching is forgiving on purpose: case, accents and apostrophes are ignored ("can't" = "cant"), a typed word matches the start of a
// word ("invoic" finds "invoice"), simple plurals match, and everyday filler words ("how do I") are ignored. Every word must match;
// if that finds nothing, articles matching any word are returned instead, best first.

import type { HelpArticle, HelpCategory } from './types'

export interface HelpSearchEntry {
  slug: string
  title: string
  summary: string
  categoryTitle: string
  answer: string
  steps: string[]
  symptoms: string[]
  /** UI labels written in **bold** in the article (button and field names), so "send to client" finds its article. */
  labels: string[]
}

export interface HelpSearchResult {
  slug: string
  title: string
  summary: string
  categoryTitle: string
  score: number
  /** A reader-worded problem that matched, shown under the result when the title alone does not explain the hit. */
  matchedSymptom?: string
}

const STOP = new Set([
  'a', 'an', 'the', 'i', 'my', 'me', 'we', 'our', 'you', 'your', 'is', 'are', 'was', 'it', 'its', 'to', 'of', 'in', 'on', 'for',
  'do', 'does', 'did', 'how', 'what', 'why', 'where', 'when', 'and', 'or', 'can', 'this', 'that', 'with', 'if', 'be', 'get', 'got',
])

export function stripMarkup(text: string): string {
  return String(text ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(\/[^)\s]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalize(text: string): string {
  return stripMarkup(text)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019\u2018`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const words = (text: string) => normalize(text).split(' ').filter(Boolean)
const stems = (text: string) => words(text).map(stem)

function boldLabels(texts: string[]): string[] {
  const seen = new Set<string>()
  for (const t of texts) for (const m of String(t ?? '').matchAll(/\*\*([^*]+)\*\*/g)) {
    const label = m[1].trim()
    if (label.length >= 3 && label.length <= 60) seen.add(label)
  }
  return [...seen].slice(0, 30)
}

export function buildHelpIndex(articles: HelpArticle[], categoryOf: (id: string) => HelpCategory | null): HelpSearchEntry[] {
  return articles.map(a => ({
    slug: a.slug,
    title: stripMarkup(a.title),
    summary: stripMarkup(a.summary),
    categoryTitle: categoryOf(a.category)?.title ?? '',
    answer: stripMarkup(a.shortAnswer).slice(0, 300),
    steps: a.steps.map(s => stripMarkup(s.title)),
    symptoms: a.problems.map(p => stripMarkup(p.symptom)),
    labels: boldLabels([
      a.shortAnswer, ...(a.beforeYouStart ?? []),
      ...a.steps.flatMap(st => [st.title, st.body, ...(st.details ?? []), ...(st.watchFor ? [st.watchFor] : [])]),
      ...a.problems.flatMap(pr => [pr.symptom, pr.meaning, pr.fix]),
    ]),
  }))
}

/** A very light stem so word forms match: delete/deleting, approve/approval, invoice/invoices, send/sending. */
export function stem(word: string): string {
  let w = word
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ied')) w = w.slice(0, -3) + 'y'
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  else if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y'
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1)
  if (w.length > 3 && w.endsWith('al')) w = w.slice(0, -2)
  return w
}

/** Things people type that the articles word differently. Each key matches any of its alternatives as well as itself. */
const SYNONYMS: Record<string, string[]> = {
  '2fa': ['two', 'factor', 'mfa'],
  mfa: ['two', 'factor'],
  '2step': ['two', 'factor'],
  co: ['order'],
  cos: ['order'],
  login: ['password', 'session'],
  signin: ['password', 'session'],
  logout: ['session'],
  price: ['plan'],
  pricing: ['plan'],
  cost: ['plan'],
  subscription: ['plan'],
  bill: ['plan', 'invoice'],
  teammate: ['member', 'team'],
  employee: ['member', 'team'],
  staff: ['member', 'team'],
  user: ['member', 'team'],
  customer: ['client'],
  contract: ['sow'],
  quote: ['sow'],
  proposal: ['sow'],
}

/** All stems a typed word may match: itself plus its synonyms. */
function alternatives(token: string): string[] {
  return [token, ...(SYNONYMS[token] ?? [])].map(stem)
}

function stemMatches(tokenStem: string, wordStem: string): boolean {
  // Very short tokens ("co", "ai") must be a whole word, or "co" would match connect, company and configure.
  if (tokenStem.length <= 2) return wordStem === tokenStem
  return wordStem.startsWith(tokenStem)
}

const hasToken = (fieldStems: string[], alts: string[]) => fieldStems.some(w => alts.some(a => stemMatches(a, w)))

const W = { title: 6, symptom: 4, label: 4, summary: 3, step: 2, answer: 1, category: 1 }

interface Prepared {
  entry: HelpSearchEntry
  title: string[]; summary: string[]; answer: string[]; category: string[]
  steps: string[][]; symptoms: string[][]; labels: string[][]
  titleText: string; symptomTexts: string[]; labelTexts: string[]
}

function prepare(entry: HelpSearchEntry): Prepared {
  return {
    entry,
    title: stems(entry.title), summary: stems(entry.summary), answer: stems(entry.answer), category: stems(entry.categoryTitle),
    steps: entry.steps.map(stems), symptoms: entry.symptoms.map(stems), labels: (entry.labels ?? []).map(stems),
    titleText: normalize(entry.title), symptomTexts: entry.symptoms.map(normalize), labelTexts: (entry.labels ?? []).map(normalize),
  }
}

/** True if the typed words appear next to each other, in order, in a field (so "change orders" matches "change order"). */
function hasPhrase(fieldStems: string[], tokenStems: string[]): boolean {
  if (tokenStems.length < 2) return false
  for (let i = 0; i + tokenStems.length <= fieldStems.length; i++) {
    if (tokenStems.every((t, j) => stemMatches(t, fieldStems[i + j]))) return true
  }
  return false
}

function tokensOf(query: string): string[] {
  const all = words(query)
  const kept = all.filter(t => !STOP.has(t))
  return kept.length ? kept : all
}

function scoreToken(p: Prepared, token: string): number {
  const alts = alternatives(token)
  let best = 0
  if (hasToken(p.title, alts)) best = Math.max(best, W.title)
  if (p.symptoms.some(s => hasToken(s, alts))) best = Math.max(best, W.symptom)
  if (p.labels.some(l => hasToken(l, alts))) best = Math.max(best, W.label)
  if (hasToken(p.summary, alts)) best = Math.max(best, W.summary)
  if (p.steps.some(s => hasToken(s, alts))) best = Math.max(best, W.step)
  if (hasToken(p.answer, alts)) best = Math.max(best, W.answer)
  if (hasToken(p.category, alts)) best = Math.max(best, W.category)
  return best
}

export function searchHelp(index: HelpSearchEntry[], query: string, limit = 12): HelpSearchResult[] {
  const q = normalize(query)
  if (q.length < 2) return []
  const tokens = tokensOf(query)
  if (!tokens.length) return []

  const prepared = index.map(prepare)
  const scored = prepared.map(p => {
    const per = tokens.map(t => scoreToken(p, t))
    const matched = per.filter(n => n > 0).length
    let score = per.reduce((a, b) => a + b, 0)
    // Phrase and title bonuses: typing (most of) a title, or a problem as the reader would say it, should win outright.
    const tokenStems = words(query).filter(w => !STOP.has(w)).map(stem)
    if (p.titleText === q) score += 30
    else if (p.titleText.startsWith(q) || p.titleText.includes(q) || hasPhrase(p.title, tokenStems)) score += 12
    if (p.symptomTexts.some(s => s === q || s.includes(q)) || p.symptoms.some(sym => hasPhrase(sym, tokenStems))) score += 8
    if (p.labelTexts.some(l => l === q)) score += 6
    else if (p.labelTexts.some(l => l.includes(q)) || p.labels.some(l => hasPhrase(l, tokenStems))) score += 3
    return { p, matched, score }
  })

  let hits = scored.filter(s => s.matched === tokens.length)
  if (!hits.length) hits = scored.filter(s => s.matched > 0)
  hits.sort((a, b) => b.matched - a.matched || b.score - a.score || a.p.entry.title.localeCompare(b.p.entry.title))

  return hits.slice(0, limit).map(({ p, score }) => {
    const titleCoversAll = tokens.every(t => hasToken(p.title, alternatives(t)))
    let matchedSymptom: string | undefined
    if (!titleCoversAll) {
      const i = p.symptoms.findIndex(s => tokens.every(t => hasToken(s, alternatives(t))))
      if (i >= 0) matchedSymptom = p.entry.symptoms[i]
    }
    return { slug: p.entry.slug, title: p.entry.title, summary: p.entry.summary, categoryTitle: p.entry.categoryTitle, score, matchedSymptom }
  })
}
