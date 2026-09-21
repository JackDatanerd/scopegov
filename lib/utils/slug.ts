// lib/utils/slug.ts
//
// Workspace handle rules. A handle is lowercase letters, digits and single
// hyphens, 3–40 characters, not starting or ending with a hyphen, and not one
// of the words the app itself routes on.

export const SLUG_MIN = 3
export const SLUG_MAX = 40

const RESERVED = new Set([
  'admin', 'api', 'app', 'auth', 'billing', 'blog', 'dashboard', 'docs', 'help',
  'invite', 'legal', 'login', 'logout', 'mfa', 'onboarding', 'portal', 'pricing',
  'scopegov', 'settings', 'signup', 'status', 'support', 'team', 'www',
])

export function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

export type SlugResult = { ok: true; value: string } | { ok: false; error: string }

export function validateSlug(input: string): SlugResult {
  const value = normalizeSlug(input)
  if (value.length < SLUG_MIN) return { ok: false, error: `Workspace handle must be at least ${SLUG_MIN} characters (letters, numbers and hyphens)` }
  if (value.length > SLUG_MAX) return { ok: false, error: `Workspace handle must be ${SLUG_MAX} characters or fewer` }
  if (RESERVED.has(value)) return { ok: false, error: 'That workspace handle is reserved. Please choose another.' }
  return { ok: true, value }
}
