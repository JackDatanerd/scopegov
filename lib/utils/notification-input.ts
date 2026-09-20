// lib/utils/notification-input.ts
//
// Request validation for /api/notifications, kept separate so it can be unit tested.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Postgres timestamptz as PostgREST returns it: 2026-09-20T10:00:05.123456+00:00 (or Z).
const TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

export const MAX_IDS = 100

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v)
}

export function parseIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IDS) return null
  if (!value.every(isUuid)) return null
  return Array.from(new Set(value as string[]))
}

/**
 * Keyset cursor: `<created_at>|<id>`.
 *
 * The timestamp is validated by shape and passed through UNCHANGED. Round-tripping it through
 * `new Date(...).toISOString()` would truncate Postgres' microseconds to milliseconds, and the
 * `created_at < cursor OR (created_at = cursor AND id < cursor_id)` comparison would then skip
 * or repeat rows whose timestamps differ only below the millisecond. Both halves are validated
 * because they are interpolated into a PostgREST `or=(...)` filter string.
 */
export function parseCursor(raw: string | null): { createdAt: string; id: string } | null {
  if (!raw) return null
  const sep = raw.lastIndexOf('|')
  if (sep < 0) return null
  const createdAt = raw.slice(0, sep)
  const id = raw.slice(sep + 1)
  if (!TIMESTAMPTZ.test(createdAt) || Number.isNaN(Date.parse(createdAt)) || !isUuid(id)) return null
  return { createdAt, id }
}
