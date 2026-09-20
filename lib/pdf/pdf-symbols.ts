// lib/pdf/pdf-symbols.ts
//
// The embedded PDF font (lib/pdf/fonts.ts, Noto Sans subset) has no glyph for the
// ✓ used by the SOW roles table, nor for arrows, ≥ ≤ ≠ or the ◦ ▪ bullets. Those
// reach sanitizePdfText() and come out as a � marker — so the roles matrix printed
// "�" where a tick belongs. mapPdfSymbols() runs BEFORE sanitizeForPdf() and swaps
// each such symbol for a plain-text equivalent the font can draw.

const SYMBOLS: Record<string, string> = {
  '✓': 'Yes', '✔': 'Yes', '☑': 'Yes', '✗': 'No', '✘': 'No', '☐': '[ ]',
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>',
  '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~',
  '◦': '-', '▪': '-', '▫': '-', '●': '•', '■': '•', '○': 'o', '□': 'o',
}
const SYMBOL_RE = new RegExp(`[${Object.keys(SYMBOLS).join('')}]`, 'g')

export function mapPdfSymbols<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.startsWith('data:') ? value : value.replace(SYMBOL_RE, ch => SYMBOLS[ch])) as unknown as T
  }
  if (Array.isArray(value)) return value.map(v => mapPdfSymbols(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapPdfSymbols(v)
    return out as T
  }
  return value
}
