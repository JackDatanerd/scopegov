// lib/documents/visible-text.ts
//
// CO-3: dependency-free (safe in the client bundle) so the editor and the server agree on what "a title" is.
// A string made only of zero-width / bidi / filler characters or lone combining marks is truthy but draws as nothing.
// ZWNJ/ZWJ are real characters in some scripts (they are \p{Cf}) so they only count alongside a visible one.
const HAS_VISIBLE_CHAR = /[^\s\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0\u2800\u180E]/u

export function hasVisibleText(text: string): boolean {
  return HAS_VISIBLE_CHAR.test(text)
}
