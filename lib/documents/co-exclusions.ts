// lib/documents/co-exclusions.ts
//
// A change order\u2019s Impact Analysis says what "remains excluded". That is a statement about the signed SOW: it is only true of
// activities the SOW\u2019s Out of Scope section names. An activity the change order merely does not cover is a different claim
// ("this change order does not include ..."), and calling it "remains excluded" tells the client it was always excluded.

const NOT_ACTIVITIES = new Set(['including', 'following', 'during', 'being', 'nothing', 'anything', 'everything', 'pricing', 'existing'])

/** Gerunds ("contacting", "managing") in the part of a sentence BEFORE "remain(s) excluded". */
export function activitiesStatedAsRemainingExcluded(scopeImpact: string | null | undefined): string[] {
  const out: string[] = []
  for (const sentence of String(scopeImpact ?? '').split(/(?<=[.;])\s+/)) {
    const m = /\bremain(?:s)?\s+(?:expressly\s+)?excluded\b/i.exec(sentence)
    if (!m) continue
    for (const g of sentence.slice(0, m.index).match(/\b[A-Za-z]{4,}ing\b/g) || []) {
      const w = g.toLowerCase()
      if (!NOT_ACTIVITIES.has(w) && !out.includes(w)) out.push(w)
    }
  }
  return out
}

/** Those activities the signed SOW\u2019s Out of Scope text never names (matched on the first five letters of the word). */
export function unnamedRemainingExclusions(scopeImpact: string | null | undefined, outOfScopeHtml: string | null | undefined): string[] {
  const oos = String(outOfScopeHtml ?? '').replace(/<[^>]+>/g, ' ').toLowerCase()
  if (!oos.trim()) return []
  return activitiesStatedAsRemainingExcluded(scopeImpact).filter(w => !new RegExp(`\\b${w.slice(0, 5)}`).test(oos))
}

export function unnamedExclusionWarning(words: string[]): string | null {
  if (!words.length) return null
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return `The Impact Analysis says ${list} remain${words.length === 1 ? 's' : ''} excluded, but the signed SOW\u2019s Out of Scope section does not name ${words.length === 1 ? 'it' : 'them'}. Say "this change order does not include \u2026" for anything the SOW did not already exclude, or send it as it is.`
}
