import { describe, it, expect } from 'vitest'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'

// Workspace lifecycle independent pass 9.
// B1: sanitizeDisplayName kept C1 control characters (U+0080-U+009F) and accepted names made only of combining /
//     variation characters, so an invisible agency name or user name passed the callers' "required" checks.

describe('sanitizeDisplayName — C1 controls and mark-only names (B1)', () => {
  it('a name made only of C1 controls (incl. U+0085 NEL) is empty', () => {
    expect(sanitizeDisplayName('\u0085\u0085')).toBe('')
    expect(sanitizeDisplayName('\u0080\u009F')).toBe('')
  })

  it('C1 controls inside a name become spaces like the ASCII controls', () => {
    expect(sanitizeDisplayName('Acme\u0085Studio')).toBe('Acme Studio')
    expect(sanitizeDisplayName('A\u009Fb')).toBe('A b')
  })

  it.each([
    ['combining grapheme joiner', '\u034F\u034F\u034F'],
    ['Khmer inherent vowels', '\u17B4\u17B5'],
    ['variation selector-16', '\uFE0F\uFE0F'],
    ['Mongolian free variation selectors', '\u180B\u180C\u180D'],
    ['variation selectors supplement', '\u{E0100}\u{E0101}'],
    ['lone combining accent', '\u0301\u0301'],
    ['marks mixed with whitespace and joiners', ' \u034F \u200D\u0301 '],
  ])('a name made only of %s is empty', (_label, input) => {
    expect(sanitizeDisplayName(input)).toBe('')
  })

  it('still accepts real names that use combining marks, joiners and variation selectors', () => {
    expect(sanitizeDisplayName('Zoe\u0308 Café')).toBe('Zoe\u0308 Café')           // decomposed diaeresis
    expect(sanitizeDisplayName('नमस्ते')).toBe('नमस्ते')                             // Devanagari vowel signs / virama
    expect(sanitizeDisplayName('ไทย')).toBe('ไทย')                                  // Thai
    expect(sanitizeDisplayName('می\u200Cخواهم')).toBe('می\u200Cخواهم')              // ZWNJ in Persian
    expect(sanitizeDisplayName('❤️ Studio')).toBe('❤️ Studio')                      // emoji + VS16
    expect(sanitizeDisplayName('👨‍👩‍👧')).toBe('👨‍👩‍👧')                                 // ZWJ emoji sequence
    expect(sanitizeDisplayName('日本のデザイン')).toBe('日本のデザイン')
  })
})
