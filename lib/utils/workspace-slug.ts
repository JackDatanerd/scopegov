// lib/utils/workspace-slug.ts
//
// Single source of the auto-generated workspace handle. Shared by POST /api/workspace/create (first
// generation) and PATCH /api/workspace/settings (regeneration while the owner is still renaming the
// agency inside the onboarding wizard) so the two can never drift apart.
//
// FIX (Onboarding independent pass 3 — B5): the suffix used nanoid's default alphabet (A-Za-z0-9_-), so
// slugs came out like 'foo--Ab_9x', '-Ab_9x' (non-Latin names strip to an empty base) or with uppercase —
// none of which Settings' own slug validator (^[a-z0-9]+(-[a-z0-9]+)*$, 3-50) accepts. Lowercase
// alphanumeric suffix, base trimmed of hyphens after the length cap, and a 'workspace' fallback.

import { customAlphabet } from 'nanoid'

const slugSuffix = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 6)

export function generateSlug(name: string): string {
  const base = name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return `${base || 'workspace'}-${slugSuffix()}`
}
