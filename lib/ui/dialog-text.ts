// lib/ui/dialog-text.ts
//
// The native browser dialogs ("www.scopegov.app says") took one plain string. The app's confirm/alert modals keep that call shape
// (a message string still works) but lay it out properly: a short title, the explanation under it, a button that names the action.
// These helpers turn a legacy message into those parts, so every dialog is consistent without rewording each call site.

export type ConfirmTone = 'default' | 'danger' | 'warning'
export type AlertTone = 'info' | 'success' | 'error' | 'warning'

export interface DialogParts { title: string; paragraphs: string[] }

const SENTENCE_END = /(?<=[.?!])\s+(?=[A-Z\u201c"'(])/

/**
 * "Delete \"X\"? This can't be undone." -> title "Delete \"X\"?", body "This can't be undone."
 * A message of several paragraphs keeps them all; a first paragraph that is one long sentence becomes the body under `fallbackTitle`.
 */
export function splitMessage(message: string, fallbackTitle: string): DialogParts {
  const paragraphs = String(message ?? '').replace(/\r/g, '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  if (!paragraphs.length) return { title: fallbackTitle, paragraphs: [] }
  const sentences = paragraphs[0].split(SENTENCE_END)
  const first = sentences[0].trim()
  if (first.length <= 80) {
    const rest = [sentences.slice(1).join(' ').trim(), ...paragraphs.slice(1)].filter(Boolean)
    return { title: first.replace(/[.]$/, ''), paragraphs: rest }
  }
  return { title: fallbackTitle, paragraphs }
}

const DANGER = /\b(delete|permanently|can(?:'|\u2019)?t be undone|cannot be undone|remove|revoke|deactivate|suspend|withdraw|void|leave)\b/i

export function confirmTone(message: string): ConfirmTone {
  return DANGER.test(message) ? 'danger' : 'default'
}

/** The button names the action: "Delete \"X\"? ..." -> "Delete"; "Send this invoice to the client now? ..." -> "Send"; otherwise "Confirm". */
export function confirmLabel(message: string): string {
  const m = /^\s*(Delete|Remove|Revoke|Deactivate|Reactivate|Suspend|Restore|Reopen|Unarchive|Archive|Withdraw|Cancel|Leave|Send|Reset|Merge|Make|Approve|Reject|Continue|Create|Save)\b/i.exec(String(message ?? ''))
  if (!m) return 'Confirm'
  const w = m[1].toLowerCase()
  return w === 'make' ? 'Make default' : w === 'cancel' ? 'Yes, cancel' : w.charAt(0).toUpperCase() + w.slice(1)
}

const NEGATIVE = /\b(could not|couldn(?:'|\u2019)?t|can(?:'|\u2019)?t|cannot|failed|unable|error|not sent|was not)\b/i

export function alertTone(message: string): AlertTone {
  const m = String(message ?? '')
  // Partial success ("The SOW is withdrawn, but the email was not sent") is a warning, not a failure: the action itself went through.
  if (/\b(but|however)\b/i.test(m) && NEGATIVE.test(m)) return 'warning'
  if (NEGATIVE.test(m)) return 'error'
  if (/^(sent|reminder sent|client link copied|merged|approved|saved|copied)\b/i.test(m)) return 'success'
  if (/\b(may want to|you may)\b/i.test(m)) return 'warning'
  return 'info'
}

export const ALERT_TITLES: Record<AlertTone, string> = { info: 'Heads up', success: 'Done', error: 'Something went wrong', warning: 'Worth a look' }
