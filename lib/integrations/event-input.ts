// lib/integrations/event-input.ts
//
// Validation of the event list a webhook subscribes to. Lives here, not in a route file: Next.js route modules may
// only export HTTP handlers.

import { INTEGRATION_EVENT_TYPES } from './events'

export function parseEventTypes(raw: unknown): { ok: true; types: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Choose at least one event.' }
  const types = Array.from(new Set(raw.map(String)))
  const unknown = types.filter(t => !INTEGRATION_EVENT_TYPES.includes(t))
  if (unknown.length) return { ok: false, error: `Unknown event: ${unknown[0]}` }
  return { ok: true, types }
}
