// lib/auth/terms.ts
//
// The version label of the Terms + Privacy Policy shown at sign-up. Bump it when
// the legal text changes; the value a person accepted is stored on
// public.users.terms_version (with a server-side timestamp) by handle_new_user()
// for email sign-ups and by /api/auth/callback for Google sign-ups.
export const TERMS_VERSION = '2026-09'
export const TERMS_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,32}$/
