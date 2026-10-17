// lib/sow/deliverable-coverage.ts
//
// The Deliverables table is written by the model from the deliverables brief, and the model can silently leave an item out (a monthly
// report that the Roles table and the prose still mention, say). The prompt asks for one row per item, but a prompt is not a check.
// This compares the brief's items with the Provider's rows and names any item no row seems to cover, so the agency can add it
// before the SOW goes out. It is a warning, never an error: matching wording is a heuristic.

const STOP = new Set([
  'with', 'from', 'that', 'this', 'each', 'every', 'their', 'there', 'which', 'when', 'where', 'will', 'shall', 'client', 'provider', 'provides', 'provided',
  'supplied', 'supply', 'including', 'include', 'includes', 'such', 'also', 'into', 'than', 'then', 'only', 'other', 'basic', 'full', 'weekly', 'monthly',
  'daily', 'per', 'and', 'the', 'for', 'etc', 'plus', 'combined', 'across', 'using', 'based', 'ongoing',
])

const plain = (s: unknown) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')

/** Splits a brief on newlines, bullets and semicolons, and on commas that are not inside brackets. */
export function briefItems(brief: unknown): string[] {
  const out: string[] = []
  for (const line of plain(brief).split(/\r?\n|;|•|\u2022/)) {
    let depth = 0, cur = ''
    for (const ch of line) {
      if (ch === '(' || ch === '[') depth++
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
      if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
    }
    out.push(cur)
  }
  return out.map(s => s.replace(/^\s*(?:[-*\d.)]+\s*)+/, '').replace(/\s+/g, ' ').trim()).filter(s => s.length > 2)
}

const stem = (w: string) => w.slice(0, 5)

function keywordStems(text: string): string[] {
  const words = plain(text).toLowerCase().match(/\p{L}{4,}/gu) ?? []
  return [...new Set(words.filter(w => !STOP.has(w)).map(stem))]
}

/**
 * Brief items that no Provider-owned row appears to cover. Rows owned by the Client are left out of the match on purpose: a Client row
 * about "analytics and traffic data access" must not make a missing "monthly analytics report" look covered.
 */
export function uncoveredDeliverables(brief: unknown, rows: Array<Record<string, string>> | null | undefined): string[] {
  const providerRows = (rows || []).filter(r => !/\bclient\b/i.test(String(r?.owner ?? '')))
  const rowStems = new Set(providerRows.flatMap(r => keywordStems(`${r?.deliverable ?? ''} ${r?.acceptanceCriteria ?? ''}`)))
  const missing: string[] = []
  for (const item of briefItems(brief)) {
    // Text inside brackets describes how an item is made ("client provides raw UGC footage"), not a deliverable of its own.
    const head = item.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    const stems = keywordStems(head)
    if (stems.length === 0) continue
    const hit = stems.filter(s => rowStems.has(s)).length
    if (hit < Math.ceil(stems.length * 0.6)) missing.push(item.replace(/[.\s]+$/, ''))
  }
  return missing
}

export function uncoveredDeliverablesWarning(brief: unknown, rows: Array<Record<string, string>> | null | undefined, language?: string | null): string | null {
  // The table of a SOW drafted in another language is written in that language from a brief that may not be, so wording cannot be
  // compared across them: say nothing rather than warn about rows that are only translated.
  if (language && !/^en\b/i.test(String(language))) return null
  const missing = uncoveredDeliverables(brief, rows)
  if (missing.length === 0) return null
  const list = missing.slice(0, 4).map(m => `\u201c${m}\u201d`).join(', ') + (missing.length > 4 ? ` and ${missing.length - 4} more` : '')
  return `The deliverables brief lists ${list}, but no Deliverables table row appears to cover ${missing.length === 1 ? 'it' : 'them'}. Add a row for ${missing.length === 1 ? 'it' : 'each'}, or confirm ${missing.length === 1 ? 'it is' : 'they are'} not part of this SOW, so what is delivered is stated in one place the client signs.`
}
