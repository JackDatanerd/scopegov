// lib/auth/login-messages.ts
//
// FIX (build — Auth independent audit, LOW): /login rendered whatever came in
// `?message=` inside the green success box, and the OAuth callback reflected
// Supabase's `error_description` straight into it. Anyone could hand out a link
// such as /login?message=Your+account+is+locked.+Call+... and have it appear as
// a trusted message on the real domain, and error states were styled as
// success. Messages are now fixed server-controlled strings selected by a short
// code (`?m=`). The legacy `?message=` parameter is honoured ONLY when it is
// exactly one of the strings this app itself used to emit (links already in
// flight); anything else is ignored.

export type LoginMessageCode =
  | 'link_invalid'
  | 'oauth_failed'
  | 'password_updated'
  | 'account_deleted'
  | 'workspace_deleted'

export interface LoginMessage {
  text: string
  tone: 'success' | 'error'
}

export const LOGIN_MESSAGES: Record<LoginMessageCode, LoginMessage> = {
  link_invalid:      { text: 'That link has expired or is no longer valid. Please try again.', tone: 'error' },
  oauth_failed:      { text: 'We couldn\u2019t complete sign-in with that provider. Please try again.', tone: 'error' },
  password_updated:  { text: 'Password updated. Please sign in again.', tone: 'success' },
  account_deleted:   { text: 'Your account has been deleted.', tone: 'success' },
  workspace_deleted: { text: 'Workspace deleted.', tone: 'success' },
}

const LEGACY_MESSAGES: Record<string, LoginMessageCode> = {
  'Link expired or invalid. Please try again.': 'link_invalid',
  'Password updated. Please sign in again.': 'password_updated',
  'Account deleted.': 'account_deleted',
  'Workspace deleted.': 'workspace_deleted',
}

export function resolveLoginMessage(code: string | null | undefined, legacyMessage?: string | null): LoginMessage | null {
  if (code && Object.prototype.hasOwnProperty.call(LOGIN_MESSAGES, code)) {
    return LOGIN_MESSAGES[code as LoginMessageCode]
  }
  if (legacyMessage && Object.prototype.hasOwnProperty.call(LEGACY_MESSAGES, legacyMessage)) {
    return LOGIN_MESSAGES[LEGACY_MESSAGES[legacyMessage]]
  }
  return null
}
