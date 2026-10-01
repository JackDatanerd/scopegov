/**
 * Convert PLAIN text (a textarea value with newlines) into the minimal rich-text HTML the Tiptap
 * RichTextField, the portal and the PDF expect: one <p> per block, <br> for single line breaks.
 *
 * workspaces.default_payment_instructions is written by Settings → Billing as plain text (a textarea,
 * stored trimmed and unescaped), but it pre-fills the invoice form's RICH-text editor. Handed the raw
 * string, ProseMirror collapses the newlines (bank / account / SWIFT lines run together) and, if the
 * user never touches the editor, the plain string is saved as the invoice's instructions and the portal
 * (dangerouslySetInnerHTML, no pre-line) shows one run-on line. Everything is escaped, so literal
 * "<" / "&" typed into the setting stay literal text. Dependency-free so it is safe in any bundle.
 */
function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function plainTextToRichHtml(text: string | null | undefined): string {
  if (typeof text !== 'string') return ''
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return ''
  return normalized
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => `<p>${block.split('\n').map(line => escapeText(line.trim())).join('<br>')}</p>`)
    .join('')
}
