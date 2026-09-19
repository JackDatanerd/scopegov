export const runtime = 'nodejs'
// FEATURE (cron audit, section 17 — feature gap, closing pass): the
// anonymization loop below has no pagination — bringing this to parity
// with payment-overdue/reconciliation-rollup rather than waiting for a
// large deleted-user backlog to actually hit the platform default first.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service  = createServiceClient()
    const now      = new Date()
    const d30ago   = new Date(now.getTime() - 30 * 86400000).toISOString()

    // FIX (re-audit, cron section): the previous fix here claimed to flip
    // status to 'expired' "the moment the 7-day token window closes" but
    // actually compared invite_token_expires_at against d7ago (now minus
    // 7 days) instead of now. Since invite_token_expires_at is itself
    // already created_at + 7 days (team/invite/route.ts), that comparison
    // only tripped once created_at + 7 days < now - 7 days — i.e.
    // created_at < now - 14 days. Invites sat at status='invited' for a
    // full 14 days after creation (double the intended 7) before this
    // ever ran, still showing "Pending" in the team UI and still blocking
    // a re-invite of the same email for a week longer than intended,
    // since the pending-invite uniqueness check in team/invite/route.ts
    // only looks at status='invited' with no expiry awareness of its own.
    // Comparing directly against `now` (the token's own actual expiry)
    // is what "the moment the window closes" actually requires.
    const { error: expireErr } = await (service as any)
      .from('workspace_members')
      .update({ status: 'expired' })
      .eq('status', 'invited')
      .lt('invite_token_expires_at', now.toISOString())
    if (expireErr) console.error('Invite expiry transition failed:', expireErr)

    // Hard-delete invite rows (invited or already-expired) older than 30 days
    const { data: purged, error: purgeErr } = await (service as any)
      .from('workspace_members')
      .delete()
      .in('status', ['invited', 'expired'])
      .lt('invite_token_expires_at', d30ago)
      .select('id')
    if (purgeErr) console.error('Invite purge failed:', purgeErr)

    // revoked_tokens cleanup (purge rows older than 60 days)
    const d60ago = new Date(now.getTime() - 60 * 86400000).toISOString()
    const { error: revokedErr } = await (service as any).from('revoked_tokens')
      .delete()
      .lt('revoked_at', d60ago)
    if (revokedErr) console.error('revoked_tokens cleanup failed:', revokedErr)

    // FEATURE (portal audit, section 18 — traced into section 17): migration
    // 030 added portal_action_log with an index on created_at clearly meant
    // for exactly this kind of housekeeping, but nothing ever purged it —
    // every portal sign/decline/accept/counter attempt (successful or not)
    // accumulated forever. Same 60-day window as revoked_tokens just above;
    // the rate limiter itself only ever looks back 10 minutes, so nothing
    // past a couple of days old still matters for its own purpose.
    const { error: portalLogErr } = await (service as any).from('portal_action_log')
      .delete()
      .lt('created_at', d60ago)
    if (portalLogErr) console.error('portal_action_log cleanup failed:', portalLogErr)

    // User anonymization (deletedAt < now - 30 days)
    // FIX (cron audit, section 17 — closing pass): this had no exclusion for
    // users already anonymized — every run re-selected and re-wrote every
    // deleted-30-days-plus user forever, since deleted_at is never cleared
    // and nothing marked a row as already processed. Idempotent (the same
    // values get written again), so harmless in effect, but the query and
    // update set grow without bound for as long as the product exists, for
    // zero benefit. Excluding rows whose email already matches the
    // anonymized pattern this same function writes stops the re-processing
    // without needing a new column.
    const { data: toAnonymize } = await (service as any)
      .from('users')
      .select('id')
      .not('deleted_at', 'is', null)
      .lt('deleted_at', d30ago)
      .not('email', 'like', 'deleted-%@deleted.scopegov.app')

    let anonymized = 0
    for (const u of (toAnonymize || [])) {
      try {
        await (service as any).from('users').update({
          email:        `deleted-${u.id}@deleted.scopegov.app`,
          name:         '[Deleted user]',
          avatar_url:   null,
          updated_at:   now.toISOString(),
        }).eq('id', u.id)
        anonymized++
      } catch (e) { console.error('Anonymization failed for:', u.id, e) }
    }

    await recordCronHeartbeat(service, 'invite-cleanup', { purgedInvites: purged?.length || 0, anonymizedUsers: anonymized })
    return NextResponse.json({
      ok: true,
      purgedInvites: purged?.length || 0,
      anonymizedUsers: anonymized,
    }, { status: (expireErr || purgeErr || revokedErr || portalLogErr) ? 207 : 200 })
  } catch (err) {
    console.error('Cleanup cron error:', err)
    await alertCronFailure(createServiceClient(), 'invite-cleanup', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. Exporting GET as an alias makes both invocation paths work.
//
// FIX (build, cron/portal audit round): the 3 sub-hourly jobs (sow-stall,
// co-stall, guardian-health) are now scheduled directly in vercel.json
// AND kept in .github/workflows/vercel-crons.yml as a redundant trigger
// (see that file's own comment for why both are kept intentionally) —
// this comment previously implied GitHub Actions was the only path,
// which stopped being true once vercel.json picked these three up too.
export const GET = POST
