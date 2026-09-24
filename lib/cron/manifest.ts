// lib/cron/manifest.ts
//
// FEATURE (cron/portal audit round 3): the single, in-repo list of every cron under app/api/cron/*.
//
// Until now "what runs, how often, and what the watchdog should expect" lived in four places that could
// drift apart with nothing to notice: the routes themselves, EXPECTATIONS inside the watchdog, the
// GitHub Actions backup workflow, and the external scopegov-cron-worker (Cloudflare) — which is NOT in
// this repo. The README still claimed the jobs were "scheduled in vercel.json" (it is `{}`). A new cron
// could ship, never be registered in the worker, and only be noticed ~27h later as a "never recorded"
// page — or, if someone forgot the watchdog entry too, never.
//
// This file is now the source of truth for:
//   • the watchdog's staleness tolerances (app/api/cron/cron-heartbeat-watchdog derives from it),
//   • the checklist of endpoints the Cloudflare worker must call (scripts/print-cron-schedule.mjs prints it),
//   • tests/cron-infra.test.ts, which fails the build if a route directory and a manifest entry ever
//     disagree, if a route stops exporting POST/GET, or if the GitHub workflow calls something unlisted.
//
// `schedule` is the UTC cron expression the scheduler should use. It is exact for the four jobs the
// GitHub backup workflow triggers (guardian-health, sow-stall, co-stall, the watchdog), trial-warning
// (08:00 per its route header) and workspace-purge (Sunday 04:00 per the watchdog's note). For the other
// daily jobs the cadence is what matters and the hour/minute here is the RECOMMENDED slot (staggered so
// the heavy ones don't overlap) — the actual Cloudflare worker config is not visible from this repo, so
// check it against `npm run cron:schedule` and change whichever side is wrong. The watchdog only uses
// `toleranceHours`, so a differing minute never causes a false page.

export type CronCadence = 'every-15-min' | 'hourly' | 'daily' | 'weekly'

export interface CronDef {
  /** Directory name under app/api/cron/. */
  name: string
  cadence: CronCadence
  /** UTC cron expression the scheduler should use. */
  schedule: string
  /**
   * How long since the last successful heartbeat before the watchdog pages. Roughly 3x the interval for
   * the frequent ones and schedule + ~18h for the daily ones (a late run must not page; a dead one must,
   * same day).
   */
  toleranceHours: number
  /** True when the run writes cron_heartbeats (everything except the watchdog itself). */
  heartbeat: boolean
  /** True when .github/workflows/vercel-crons.yml also triggers it as a redundant backup. */
  githubBackup?: boolean
  description: string
}

export const CRON_MANIFEST: readonly CronDef[] = [
  { name: 'guardian-health',         cadence: 'every-15-min', schedule: '*/15 * * * *', toleranceHours: 2,   heartbeat: true, githubBackup: true,
    description: 'Guardian pipeline health: unresolved classification failures, ops alerts' },
  { name: 'sow-stall',               cadence: 'hourly', schedule: '0 * * * *',  toleranceHours: 3,   heartbeat: true, githubBackup: true,
    description: 'Marks a project Stalled when its SOW has sat unsigned for 7 days' },
  { name: 'co-stall',                cadence: 'hourly', schedule: '30 * * * *', toleranceHours: 3,   heartbeat: true, githubBackup: true,
    description: 'Marks an unanswered change order Stalled after 5 days' },
  { name: 'cron-heartbeat-watchdog', cadence: 'hourly', schedule: '45 * * * *', toleranceHours: 3,   heartbeat: false, githubBackup: true,
    description: 'Pages ops when any other cron has gone quiet (cannot watch itself — GitHub + worker both trigger it)' },

  { name: 'notification-cleanup',    cadence: 'daily', schedule: '30 2 * * *',  toleranceHours: 27,  heartbeat: true,
    description: 'Retention: notifications, email_log, ai_usage_log, cron_run_history, snapshot downsampling' },
  { name: 'invite-cleanup',          cadence: 'daily', schedule: '0 3 * * *',   toleranceHours: 27,  heartbeat: true,
    description: 'Invite expiry/purge, token + rate-limit retention, 30-day account erasure' },
  { name: 'project-purge',          cadence: 'daily', schedule: '30 3 * * *',  toleranceHours: 27,  heartbeat: true,
    description: 'Hard-deletes projects soft-deleted more than 30 days ago (rows, evidence files, executed PDFs)' },
  { name: 'reconciliation-rollup',   cadence: 'daily', schedule: '0 5 * * *',   toleranceHours: 27,  heartbeat: true,
    description: 'Nightly contract-position snapshot per live project' },
  { name: 'scope-health-rollup',     cadence: 'daily', schedule: '30 5 * * *',  toleranceHours: 27,  heartbeat: true,
    description: 'Nightly scope-health snapshot per workspace' },
  { name: 'retainer-milestones',     cadence: 'daily', schedule: '0 6 * * *',   toleranceHours: 27,  heartbeat: true,
    description: 'Generates the monthly retainer payment milestones' },
  { name: 'signing-integrity',       cadence: 'daily', schedule: '30 6 * * *',  toleranceHours: 27,  heartbeat: true,
    description: 'Repairs signed SOWs / accepted COs whose post-signing steps partly failed' },
  { name: 'co-expiry',               cadence: 'daily', schedule: '0 7 * * *',   toleranceHours: 27,  heartbeat: true,
    description: 'Expires change orders whose signing link has died and releases their Guardian flag' },
  { name: 'sow-expiry',              cadence: 'daily', schedule: '5 7 * * *',   toleranceHours: 27,  heartbeat: true,
    description: 'Expires SOWs whose signing link has died' },
  { name: 'invoice-expiry',          cadence: 'daily', schedule: '10 7 * * *',  toleranceHours: 27,  heartbeat: true,
    description: 'Renews invoice portal tokens that have expired' },
  { name: 'trial-warning',           cadence: 'daily', schedule: '0 8 * * *',   toleranceHours: 27,  heartbeat: true,
    description: 'Trial-ending warnings (08:00 UTC per the route header)' },
  { name: 'payment-overdue',         cadence: 'daily', schedule: '0 9 * * *',   toleranceHours: 27,  heartbeat: true,
    description: 'Overdue milestones/invoices, trial expiry, billing grace reminders + enforcement' },
  { name: 'approval-stall',          cadence: 'daily', schedule: '30 9 * * *',  toleranceHours: 27,  heartbeat: true,
    description: 'Reminds/escalates approval requests that have sat unanswered' },
  { name: 'guardian-flag-stall',     cadence: 'daily', schedule: '0 10 * * *',  toleranceHours: 27,  heartbeat: true,
    description: 'Reminds on Guardian flags left open / borderline' },
  { name: 'client-reminders',        cadence: 'daily', schedule: '30 10 * * *', toleranceHours: 27,  heartbeat: true,
    description: 'Opt-in automatic client reminders (SOW, CO, invoices)' },
  { name: 'billing-reconcile',       cadence: 'daily', schedule: '0 11 * * *',  toleranceHours: 27,  heartbeat: true,
    description: 'Compares local billing state with Paystack and repairs unambiguous drift' },

  { name: 'workspace-purge',         cadence: 'weekly', schedule: '0 4 * * 0',  toleranceHours: 192, heartbeat: true,
    description: 'Hard-deletes workspaces soft-deleted more than 7 years ago (Sunday 04:00 UTC)' },
]

export const CRON_BY_NAME: ReadonlyMap<string, CronDef> = new Map(CRON_MANIFEST.map(c => [c.name, c]))

/** Watchdog expectations: every cron that writes a heartbeat, with its tolerance in hours. */
export function heartbeatExpectations(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of CRON_MANIFEST) if (c.heartbeat) out[c.name] = c.toleranceHours
  return out
}
