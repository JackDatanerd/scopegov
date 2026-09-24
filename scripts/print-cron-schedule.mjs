// Prints the cron manifest as a checklist for the external scheduler (scopegov-cron-worker).
// Usage: npm run cron:schedule   (needs Node >= 22.6 for --experimental-strip-types)
import { CRON_MANIFEST } from '../lib/cron/manifest.ts'

const pad = (s, n) => String(s).padEnd(n)
console.log(pad('CRON', 26), pad('SCHEDULE (UTC)', 16), pad('TOLERANCE', 10), 'ENDPOINT')
for (const c of CRON_MANIFEST) {
  console.log(pad(c.name, 26), pad(c.schedule, 16), pad(`${c.toleranceHours}h`, 10), `POST /api/cron/${c.name}${c.githubBackup ? '   (+ GitHub backup)' : ''}`)
}
console.log(`\n${CRON_MANIFEST.length} crons. Every one needs "Authorization: Bearer $CRON_SECRET".`)
