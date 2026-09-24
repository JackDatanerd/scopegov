export const runtime = 'nodejs'
export const maxDuration = 60

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronMissedHeartbeat, alertCronFailure } from '@/lib/utils/cron-alert'
import { heartbeatExpectations } from '@/lib/cron/manifest'

// FEATURE (cron audit, section 17 — feature gap, closing pass): nothing in
// this codebase previously noticed a cron that simply didn't run — an
// entry dropped from the scheduler, CRON_SECRET drifting out of sync, or a
// platform outage all fail exactly the same way: no request ever arrives,
// so there's no error for alertCronFailure to catch from the inside.
// This is the outside check: every cron writes a heartbeat
// (lib/utils/cron-heartbeat.ts, migration 058) on successful completion,
// and this route pages ops the moment one goes stale by more than its own
// tolerance.
//
// FIX (cron/portal audit round 3):
//   • The expectations are no longer a hand-maintained table in this file (whose header claimed it was
//     "scoped to 10 crons" while listing 19). They derive from lib/cron/manifest.ts, and
//     tests/cron-infra.test.ts fails if a cron route exists that the manifest doesn't know about.
//   • Re-paging: the per-cron cooldown was 1h and this route runs hourly, so a cron that stayed stale
//     re-paged on every single watchdog run — the comment here said the opposite. During a wide outage
//     (say a rotated CRON_SECRET) that was ~20 emails an hour. Now: a stale cron re-pages every
//     6-24h (scaled to its own tolerance), and when four or more are stale at once ONE digest goes out
//     instead of one email per cron — a wide outage has a single cause and needs a single page.
const EXPECTATIONS: Record<string, number> = heartbeatExpectations()

const HOUR = 3_600_000
/** Re-page cadence for a cron that stays stale: half its tolerance, clamped to 6h..24h. */
const missedCooldownMs = (toleranceHours: number) => Math.min(24, Math.max(6, toleranceHours / 2)) * HOUR
const DIGEST_THRESHOLD = 4

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

    const staleDetail: Array<{ cronName: string; toleranceHours: number; message: string }> = []
    for (const [cronName, toleranceHours] of Object.entries(EXPECTATIONS)) {
      const lastOkAt = seen.get(cronName)
      // No row at all reads the same as "stale" — either it has never once succeeded since this table
      // existed, or it's been long enough that the row was never written in the first place. Both need
      // a human, not a free pass because the comparison has nothing to compare against.
      const ageHours = lastOkAt ? (now - new Date(lastOkAt).getTime()) / 3_600_000 : Infinity
      if (ageHours > toleranceHours) {
        const message = `${cronName}: last success ${lastOkAt ? `${ageHours.toFixed(1)}h ago (${lastOkAt})` : 'never recorded'} — tolerance ${toleranceHours}h`
        stale.push(message)
        staleDetail.push({ cronName, toleranceHours, message })
      }
    }

    if (staleDetail.length >= DIGEST_THRESHOLD) {
      // One digest for a wide outage (single shared cause: secret drift, scheduler down, deploy broken).
      await alertCronMissedHeartbeat(
        service, '__many__', `${staleDetail.length} crons have gone quiet:\n` + staleDetail.map(d => `  • ${d.message}`).join('\n'),
        6 * HOUR,
      )
    } else {
      // Per-cron cooldown key (via alertCronMissedHeartbeat) so one stale cron doesn't suppress or get
      // bundled with another's alert.
      for (const d of staleDetail) await alertCronMissedHeartbeat(service, d.cronName, d.message, missedCooldownMs(d.toleranceHours))
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
