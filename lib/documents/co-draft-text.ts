// lib/documents/co-draft-text.ts
//
// Backstops for the AI change-order drafter. The model writes client-facing wording about the SOW it amends, so anything it
// copies from internal data or states more loosely than the contract needs is cleaned up here, deterministically.

/**
 * Guardian flags fall back to the internal label "General scope" when the classifier matched no SOW item. That label is not
 * a section of any SOW; when the model copied it into the Impact Analysis the client read 'falls under ... (General scope)'.
 */
export function isGenericScopeReference(ref: unknown): boolean {
  const t = String(ref ?? '').trim().replace(/[.\s]+$/, '')
  return !t || /^general scope$/i.test(t)
}

/** Removes internal fallback labels the model may have echoed, in parentheses or as a quoted section name. */
export function stripInternalScopeLabels(text: string): string {
  return String(text ?? '')
    .replace(/\s*\(\s*(?:the\s+)?["\u201c']?general scope["\u201d']?\s*\)/gi, '')
    .replace(/\s*,?\s*(?:in|under)\s+(?:the\s+)?["\u201c']general scope["\u201d']\s+(?:section|item)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * "fee per candidate contacted" / "billed as used" say the OPPOSITE of a fixed sum. A change order total is one agreed figure, so a
 * line capped at its own quantity must not describe itself as billed by actual use. Removes that phrasing (keeping the sentence
 * break it carried) so the basis clause below is the only statement of the billing basis.
 */
export function stripPerUseBilling(description: string): string {
  const PER_USE = /,?\s*(?:(?:the\s+)?(?:one-time\s+)?fee\s+(?:is\s+)?|billed\s+|charged\s+)?per\s+[a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3}\s+(?:contacted|used|delivered|reached|approached|messaged|sent)\b(\.?)/gi
  return String(description ?? '')
    .replace(PER_USE, (_m, dot: string) => dot || '')
    .replace(/,?\s*(?:billed|charged|invoiced)\s+(?:as|by|on)\s+(?:actual\s+)?(?:used|use|usage|delivered)\b/gi, '')
    .replace(/\s*,\s*\./g, '.')
    .replace(/\(\s*([^()]*?)\s*[,;]\s*\)/g, '($1)')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * A per-unit line capped at its own quantity ("up to 10 candidates ... ", quantity 10) bills the whole quantity, but nothing said
 * so: a client who approves 6 of 10 cannot tell whether 6 or 10 units are owed. The description states the basis (after
 * removing any per-use wording that contradicts it). Lines whose wording already settles it, and lines whose quantity is not
 * the cap, are left alone.
 */
export function ensureCappedQuantityBasis(description: string, quantity: number): string {
  const text = String(description ?? '')
  const m = /\bup to\s+(\d[\d,]*)\b/i.exec(text)
  if (!m) return text
  const cap = Number(m[1].replace(/,/g, ''))
  if (!(quantity > 1) || quantity !== cap) return text
  if (/\bwhether or not\b|\bregardless\b|\bfull quantity\b/i.test(text)) return text
  const cleaned = stripPerUseBilling(text)
  return `${cleaned.replace(/[\s.;,]+$/, '')}; the fee covers the full quantity of ${cap}, whether or not all are used`
}

/** Table-cell style: a line description carries no trailing full stop, so every line in one change order ends the same way. */
export function normalizeLineEnding(description: string): string {
  return String(description ?? '').trim().replace(/\.+$/, '').trim()
}

/**
 * The project name is an internal label ("V6 DTC Skincare"), not the client's brand. When the model prints it as one ("for the V6
 * DTC Skincare brand"), the client reads an internal label as their own brand. Rewrites the "<name> brand/business/company"
 * form to "the Client's brand"; the prompt asks the model not to do this in the first place.
 */
export function scrubProjectNameAsBrand(text: string, projectName: string | null | undefined): string {
  const name = String(projectName ?? '').trim()
  const t = String(text ?? '')
  if (name.length < 3) return t
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // "<name> brand's social content" -> "the brand's social content" (not the double possessive "the Client's brand's"); else "the Client's brand".
  return t.replace(new RegExp(`(?:\\b(?:the|this|your|our)\\s+)?${esc}(?:['\u2019]s)?\\s+(?:brand|business|company|product line|products?)(['\u2019]s)?\\b`, 'gi'),
    (_m, poss: string | undefined) => (poss ? `the brand${poss}` : "the Client's brand"))
}

/**
 * An invoice or change-order TITLE is client-facing, and the project name is an internal label ("V7 DTC Skincare"). The invoice
 * drafter's own example title is "Fleet Rollout - Wave 2 completion", which teaches it to prefix the project name. Removes a leading
 * or trailing "<project name> <separator>" from a drafted title and re-capitalises what is left.
 */
export function stripProjectNameFromTitle(title: string, projectName: string | null | undefined): string {
  const t = String(title ?? '').trim()
  const name = String(projectName ?? '').trim()
  if (name.length < 3) return t
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const out = t
    .replace(new RegExp(`^${esc}\\s*[\\u2014\\u2013\\-:|\\u00b7,]\\s*`, 'i'), '')
    .replace(new RegExp(`\\s*[\\u2014\\u2013\\-:|\\u00b7,]\\s*${esc}$`, 'i'), '')
    .trim()
  return out ? out.replace(/^([a-z])/, (c) => c.toUpperCase()) : t
}

/**
 * "This work falls outside the 'Out of Scope' section" says the opposite of what it means: work listed there is excluded, so it
 * falls UNDER that section. The drafter's own prompt used to phrase it that way; this rewrites any that slip through.
 */
export function fixOutOfScopePhrasing(text: string): string {
  return String(text ?? '').replace(/\b(falls?|sits?|lies?)\s+outside\s+(?:of\s+)?(the\s+["\u201c\u2018']?Out of Scope["\u201d\u2019']?\s+(?:section|list|items?))/gi,
    (_m, verb: string, rest: string) => `${verb} under ${rest}`)
}

/**
 * What a change order's lines say the work does NOT include ("… it does not include outreach, negotiation, contracting or
 * management"). A line can exclude things the signed SOW's Out of Scope section never mentions (outreach, program management),
 * so the Impact Analysis has to say so, or the amended SOW reads as if those activities are now open.
 */
export function excludedActivities(lines: Array<{ description?: string | null }>): string[] {
  const out: string[] = []
  for (const l of lines || []) {
    const m = /\b(?:does|do|will)\s+not\s+include\s+([^.;]+)/i.exec(String(l?.description ?? ''))
    if (!m) continue
    for (const raw of m[1].split(/,|\band\b|\bor\b/i)) {
      const a = raw.trim().replace(/^(?:any|the|its|their)\s+/i, '').replace(/\s+/g, ' ')
      if (a && a.length <= 40 && !out.some(x => x.toLowerCase() === a.toLowerCase())) out.push(a)
    }
  }
  return out
}

// "contracting" / "contract", "managing" / "management", "negotiation" / "negotiating": five letters of the last word match them all.
const stemOf = (activity: string) => (activity.toLowerCase().split(/\s+/).pop() || '').slice(0, 5)

/** Activities a line excludes that the Scope impact note does not mention. */
export function unstatedExclusions(scopeImpact: string | null | undefined, lines: Array<{ description?: string | null }>): string[] {
  const note = String(scopeImpact ?? '').toLowerCase()
  return excludedActivities(lines).filter(a => { const st = stemOf(a); return st.length >= 4 && !note.includes(st) })
}

function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/** Appends one sentence naming any line-level exclusion the note leaves out. Nothing changes when the note already covers them. */
export function ensureAddedExclusionsStated(scopeImpact: string | null | undefined, lines: Array<{ description?: string | null }>): string | null {
  const note = String(scopeImpact ?? '').trim()
  const missing = unstatedExclusions(note, lines)
  if (!note || missing.length === 0) return note || null
  const sep = /[.!?]$/.test(note) ? ' ' : '. '
  return `${note}${sep}The added work does not include ${joinList(missing)}.`
}
