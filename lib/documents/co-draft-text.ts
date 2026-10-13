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
 * A per-unit line capped at its own quantity ("up to 10 candidates ... per candidate contacted", quantity 10) bills the whole
 * quantity, but nothing said so: a client who approves 6 of 10 cannot tell whether 6 or 10 units are owed. The description
 * states the basis. Lines whose wording already settles it, and lines whose quantity is not the cap, are left alone.
 */
export function ensureCappedQuantityBasis(description: string, quantity: number): string {
  const text = String(description ?? '')
  const m = /\bup to\s+(\d[\d,]*)\b/i.exec(text)
  if (!m) return text
  const cap = Number(m[1].replace(/,/g, ''))
  if (!(quantity > 1) || quantity !== cap) return text
  if (/\bwhether or not\b|\bregardless\b|\bfull quantity\b|\bbilled (?:for|as)\b|\bas used\b|\bactually (?:used|contacted|delivered)\b/i.test(text)) return text
  return `${text.replace(/[\s.;,]+$/, '')}; the fee covers the full quantity of ${cap}, whether or not all are used`
}
