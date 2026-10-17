// lib/documents/title-case.ts
//
// Document titles in the product are written in Title Case ("V10 DTC Skincare", "Website Redesign"), but the AI drafters write
// sentence case ("Influencer and affiliate partner identification"), so a change order read differently from the SOW and invoice
// next to it. Applied only to text the model drafted; a title a person types is never rewritten.

const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'off', 'on', 'onto', 'or', 'per', 'the', 'to', 'up', 'via', 'vs', 'with',
])

function capitalizeWord(word: string): string {
  // Brand and acronym spellings (TikTok, DTC, iOS, A/B) and anything with a digit are the person's own capitalisation: leave them.
  if (/[A-Z]/.test(word.slice(1)) || /\d/.test(word) || /^[A-Z]{2,}$/.test(word)) return word
  const i = word.search(/[A-Za-z]/)
  if (i < 0) return word
  return word.slice(0, i) + word[i].toUpperCase() + word.slice(i + 1)
}

export function toTitleCase(input: string): string {
  const text = String(input ?? '').trim()
  if (!text) return text
  const tokens = text.split(/(\s+)/)
  const wordIdx = tokens.map((t, i) => (/\S/.test(t) ? i : -1)).filter(i => i >= 0)
  const first = wordIdx[0]
  const last = wordIdx[wordIdx.length - 1]
  return tokens.map((tok, i) => {
    if (!/\S/.test(tok)) return tok
    // hyphenated compounds: each part is judged on its own ("one-time" -> "One-Time"); small words inside stay lower
    return tok.split('-').map((part, pi) => {
      const bare = part.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toLowerCase()
      const isEdge = (i === first && pi === 0) || i === last
      if (bare && SMALL_WORDS.has(bare) && !isEdge) return part
      return capitalizeWord(part)
    }).join('-')
  }).join('')
}

/**
 * Title Case is an English convention. Spanish, French, Portuguese and Swahili titles are written in sentence case and German
 * capitalises nouns by its own rules, so a document in another language keeps its titles exactly as written.
 */
export function toTitleCaseFor(text: string, language: string | null | undefined): string {
  return !language || /^en\b/i.test(String(language)) ? toTitleCase(text) : String(text ?? '')
}
