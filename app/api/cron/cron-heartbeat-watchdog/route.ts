export const runtime = 'nodejs'
export const maxDuration = 60

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronMissedHeartbeat, alertCronFailure } from '@/lib/utils/cron-alert'

// FEATURE (cron audit, section 17 — feature gap, closing pass): nothing in
// this codebase previously noticed a cron that simply didn't run — an
// entry silently dropped from vercel.json, CRON_SECRET drifting out of
// sync, or a Vercel platform outage all fail exactly the same way: no
// request ever arrives, so there's no error for alertCronFailure to catch
// from the inside. This is the outside check: every cron below writes a
// heartbeat (lib/utils/cron-heartbeat.ts, migration 058) on successful
// completion, and this route — itself scheduled independently in
// vercel.json — pages ops the moment one goes stale by more than its own
// tolerance.
//
// Scoped for now to the 10 crons covered by this audit pass
// (approval-stall, co-stall, sow-stall, retainer-milestones,
// payment-overdue, reconciliation-rollup, invite-cleanup, project-purge,
// workspace-purge, trial-warning). billing-reconcile, co-expiry,
// guardian-flag-stall, guardian-health, invoice-expiry, scope-health-
// rollup, and sow-expiry aren't wired to a heartbeat yet — add them to
// EXPECTATIONS below (and a recordCronHeartbeat call in each) as they get
// their own audit pass, rather than assuming this list is exhaustive.
//
// toleranceHours is each cron's own schedule interval plus a buffer wide
// enough to absorb a normal late/slow run without paging on noise:
// roughly 3x the interval for the hourly pair (a single missed run
// shouldn't page — co-stall/sow-stall already have a GitHub Actions
// redundant trigger for that), and schedule + ~18h for the daily ones
// (long enough that a run merely running late doesn't trip it, short
// enough that a genuinely dead cron still pages same-day).
const EXPECTATIONS: Record<string, number> = {
  'co-stall':             3,
  'sow-stall':            3,
  'trial-warning':        27,
  'payment-overdue':      27,
  'invite-cleanup':       27,
  'retainer-milestones':  27,
  'project-purge':        27,
  'reconciliation-rollup': 27,
  'approval-stall':       27,
  'workspace-purge':      192, // weekly (Sun 04:00) + ~1 day buffer
  // Heartbeats added in cron audit round 2 (these seven previously had no heartbeat and no failure alert):
  'billing-reconcile':    27,
  'co-expiry':            27,
  'sow-expiry':           27,
  'invoice-expiry':       27,
  'guardian-flag-stall':  27,
  'scope-health-rollup':  27,
  'guardian-health':      2,  // every 15 minutes
  'client-reminders':     27, // daily; opt-in per workspace, but the run itself always records a heartbeat
  'notification-cleanup': 27, // daily; heartbeat added with the cron in the Notifications & email round
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  try {
    const { data: heartbeats, error: hbErr } = await (service as any)
      .from('cron_heartbeats')
      .select('cron_name, last_ok_at')
    // A failed read used to look like "no heartbeats recorded" (every cron 'never recorded') or, worse,
    // was ignored — the one job whose whole purpose is noticing silence must not fail silently itself.
    if (hbErr) throw new Error(`cron_heartbeats read failed: ${hbErr.message}`)

    const seen = new Map<string, string>((heartbeats || []).map((h: any) => [h.cron_name, h.last_ok_at]))
    const now  = Date.now()
    const stale: string[] = []

    for (const [cronName, toleranceHours] of Object.entries(EXPECTATIONS)) {
      const lastOkAt = seen.get(cronName)
      // No row at all reads the same as "stale" — either it has never
      // once succeeded since this table existed, or it's been long enough
      // that the row was never written in the first place. Both need a
      // human, not a free pass because the comparison has nothing to
      // compare against.
      const ageHours = lastOkAt ? (now - new Date(lastOkAt).getTime()) / 3_600_000 : Infinity
      if (ageHours > toleranceHours) {
        stale.push(`${cronName}: last success ${lastOkAt ? `${ageHours.toFixed(1)}h ago (${lastOkAt})` : 'never recorded'} — tolerance ${toleranceHours}h`)
        // FEATURE (cron audit, section 17): per-cron cooldown key (via
        // alertCronMissedHeartbeat) so one stale cron doesn't also
        // suppress or get bundled with another's alert, and a cron that
        // stays stale for days doesn't re-page on every watchdog run.
        await alertCronMissedHeartbeat(service, cronName, stale[stale.length - 1])
      }
    }

    return NextResponse.json({ ok: true, checked: Object.keys(EXPECTATIONS).length, stale })
  } catch (err) {
    console.error('Cron heartbeat watchdog error:', err)
    await alertCronFailure(service, 'cron-heartbeat-watchdog', err).catch(() => {})
    return NextResponse.json({ error: 'Watchdog failed' }, { status: 500 })
  }
}

// Vercel Cron invokes the configured path with GET, not POST (see
// co-stall/route.ts for the full explanation) — alias so both work.
export const GET = POST
