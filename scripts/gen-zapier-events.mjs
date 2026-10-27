// Regenerates integrations/zapier/events.json from the event catalog (the single source of truth).
// Usage: node --experimental-strip-types scripts/gen-zapier-events.mjs        (Node >= 22.6)
// tests/integrations-foundation.test.ts fails if the committed file drifts from the catalog.
import { writeFileSync } from 'node:fs'
import { EVENT_CATALOG, sampleEnvelope } from '../lib/integrations/event-catalog.ts'

const events = EVENT_CATALOG.map(e => ({ type: e.type, label: e.label, description: e.description, sample: sampleEnvelope(e) }))
writeFileSync(new URL('../integrations/zapier/events.json', import.meta.url), JSON.stringify(events, null, 2) + '\n')
console.log(`wrote ${events.length} events`)
