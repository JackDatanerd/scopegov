// lib/documents/co-draft-quantity.ts
//
// The AI drafter picks a quantity for every change-order line, but pricing comes from the agency: the model never sets a rate. A model
// that writes one deliverable ("a single shortlist document of up to 15 candidates") and also returns quantity 5 hands the agency a
// line that prints "5 x rate" for one document, and the client asks "five of what?". A limit such as "up to 15 candidates" belongs in
// the description; the quantity is how many times the fee applies. A line that names ONE deliverable, with no "per"/"each" unit, is
// therefore quantity 1.

const SINGLE_DELIVERABLE = /\b(?:a|an|one|1|single|the)\s+(?:[\w'-]+\s+){0,3}?(?:document|report|brief|shortlist|deck|plan|audit|guide|review|summary|proposal|package|template|playbook|checklist|strategy|presentation|spreadsheet|file)\b/i
const HAS_UNIT = /\b(?:per|each|every)\b|\bx\s?\d|\b\d+\s*(?:x|×)\b/i

export function normalizeDraftQuantity(description: string, quantity: number): number {
  if (!(quantity > 1)) return quantity
  const text = String(description || '')
  if (HAS_UNIT.test(text)) return quantity
  return SINGLE_DELIVERABLE.test(text) ? 1 : quantity
}
