// lib/sow/figures.ts
//
// FIX (SOW lifecycle independent pass 10, B6): the SOW generator tells the model "Use ONLY the exact figures
// provided … never invent payment amounts, fees, rates, or revision counts", but the single-section rewrite
// ("Improve" wand, api/sow/regenerate-section) only asked for clarity and a word limit. Run on Payment Terms or
// Revision Policy, it could change "USD 12,500" or "2 revision rounds" — or drop them — and the result was
// autosaved straight into the draft. Send then only warned when the contract value was missing from Payment
// Terms (and not at all for revision rounds or instalment amounts). This is the server-side backstop for the
// prompt rule: a rewrite must carry exactly the same set of figures as the text it replaced, unless the person
// typed a number into their own instruction (they are deliberately changing a figure).

import { amountsMentioned } from '@/lib/sow/validate-send'

function plain(html: string): string {
  return String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim()
}

function figureSet(html: string): number[] {
  const out: number[] = []
  for (const n of amountsMentioned(plain(html))) {
    if (!out.some(x => Math.abs(x - n) < 0.005)) out.push(n)
  }
  return out
}

/** True when `next` states exactly the figures `current` did (or the instruction itself supplies figures). */
export function figuresPreserved(current: string, next: string, instruction?: string | null): boolean {
  if (instruction && /\d/.test(instruction)) return true
  const before = figureSet(current)
  const after = figureSet(next)
  const has = (list: number[], n: number) => list.some(x => Math.abs(x - n) < 0.005)
  return before.every(n => has(after, n)) && after.every(n => has(before, n))
}
