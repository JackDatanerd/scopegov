// lib/pdf/fonts.ts
//
// FIX (Reports & Audit follow-up): every PDF in the app (SOW, CO, invoice,
// audit export, scope/financial/portfolio reports) used react-pdf's built-in
// Helvetica, a WinAnsi-encoded standard font. Anything outside Windows-1252
// was not just missing — it was silently CORRUPTED, character by character:
// "Michał Żółć" printed as "MichaB {óB", "Việt Nam" as "ViÇt Nam", Cyrillic
// came out as ASCII-looking symbols, "Ştefan" as "^tefan" and "Čeština" as
// "eština". A client or team-member name, a project name or an audit-trail
// entity name in Polish, Czech, Romanian, Turkish, Vietnamese, Russian or
// Greek (or a ₦ / ₵ amount label) therefore landed in a signed contract or a
// compliance export as different text from what was recorded.
//
// The families below embed Noto Sans (SIL OFL), subset to Latin, Latin-
// Extended, Vietnamese, Cyrillic and Greek plus general punctuation and
// currency symbols. Each face is its own single-style family so existing
// `fontFamily: 'Helvetica-Bold'`-style call sites map 1:1 without touching
// fontWeight/fontStyle resolution. Still NOT covered: CJK, Arabic/Hebrew (RTL
// shaping) and emoji — those need much larger fonts and a layout decision.
// Courier (used only for numeric amounts and document numbers) is unchanged.

import { Font } from '@react-pdf/renderer'
import {
  NOTO_SANS_REGULAR_B64, NOTO_SANS_BOLD_B64, NOTO_SANS_ITALIC_B64, NOTO_SANS_BOLD_ITALIC_B64,
  NOTO_SANS_SUPPORTED_RANGES,
} from './fonts/noto-sans-data'

export const PDF_FONT = {
  sans:       'ScopeSans',
  bold:       'ScopeSans-Bold',
  italic:     'ScopeSans-Italic',
  boldItalic: 'ScopeSans-BoldItalic',
} as const

const dataUri = (b64: string) => `data:font/ttf;base64,${b64}`

let registered = false
function registerPdfFonts() {
  if (registered) return
  registered = true
  Font.register({ family: PDF_FONT.sans,       src: dataUri(NOTO_SANS_REGULAR_B64) })
  Font.register({ family: PDF_FONT.bold,       src: dataUri(NOTO_SANS_BOLD_B64) })
  Font.register({ family: PDF_FONT.italic,     src: dataUri(NOTO_SANS_ITALIC_B64) })
  Font.register({ family: PDF_FONT.boldItalic, src: dataUri(NOTO_SANS_BOLD_ITALIC_B64) })
}

registerPdfFonts()

// ── Text the embedded font cannot draw ───────────────────────────────────
// A character outside the subset (CJK, Arabic, Hebrew, emoji, arrows, …)
// used to reach the PDF as whatever glyph the encoder happened to map it to —
// the same silent mojibake as before, just for fewer characters. Replace each
// one with an explicit � (U+FFFD, which Noto Sans does contain) so a reader can see that something was not
// representable, instead of reading confidently wrong text. Keep this range
// list in sync with `unicodes` in scripts/build-pdf-fonts.py.
// The exact set of code points present in all four embedded faces is emitted
// by scripts/build-pdf-fonts.py from the subset fonts' own cmaps, so this can
// never drift from what the font can actually draw (a hand-written range list
// once claimed ≠ ≤ ≥, which Noto Sans does not contain).
const SUPPORTED_RANGES = NOTO_SANS_SUPPORTED_RANGES

export const PDF_REPLACEMENT_CHAR = '\uFFFD'

function isSupported(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0A || cp === 0x0D) return true // whitespace controls have no glyph but are not text
  for (const [lo, hi] of SUPPORTED_RANGES) if (cp >= lo && cp <= hi) return true
  return false
}

export function sanitizePdfText(text: string): string {
  let out = ''
  for (const ch of text) out += isSupported(ch.codePointAt(0)!) ? ch : PDF_REPLACEMENT_CHAR
  return out
}

/**
 * Deep-copies `value`, running every string through sanitizePdfText. Strings
 * that are data URIs (logos, signatures) are left byte-for-byte alone.
 */
export function sanitizeForPdf<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.startsWith('data:') ? value : sanitizePdfText(value)) as unknown as T
  }
  if (Array.isArray(value)) return value.map(v => sanitizeForPdf(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeForPdf(v)
    return out as T
  }
  return value
}
