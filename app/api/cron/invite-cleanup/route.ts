export const runtime = 'nodejs'
// Anonymization is one sequential auth-admin round trip per user — same unbounded shape
// payment-overdue carries this override for.
export const maxDuration = 300

import { removeAvatarObjects } from '@/lib/utils/avatar-storage'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { CronRun, fetchAll } from '@/lib/utils/cron-run'
import { anonymizeAuthUser, anonymizedEmail, banAuthUser, isAuthUserBanned } from '@/lib/utils/account-erasure'

const DAY = 86400000

// Daily housekeeping: invite expiry/purge, token + rate-limit retention, and the 30-day account-erasure
// sweep. (Notification retention lives in cron/notification-cleanup.) Each part is an independent step (see lib/utils/cron-run.ts).
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const run = new CronRun(service, 'invite-cleanup')
  const now = new Date()
  const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY).toISOString()
  let purgedInvites = 0, anonymized = 0, bannedLegacy = 0, skippedActive = 0

  // 1. Expire invites whose token has lapsed.
  await run.step('expire invites', async () => {
    const { error } = await (service as any).from('workspace_members')
      .update({ status: 'expired' })
      .eq('status', 'invited')
      .lt('invite_token_expires_at', now.toISOString())
    if (error) throw new Error(error.message)
  })

  // 2. Hard-delete invites that expired more than 30 days ago (nothing references an invited-only row).
  await run.step('purge stale invites', async () => {
    const { data, error } = await (service as any).from('workspace_members')
      .delete()
      .in('status', ['invited', 'expired'])
      .lt('invite_token_expires_at', iso(30))
      .select('id')
    if (error) throw new Error(error.message)
    purgedInvites = data?.length || 0
  })

  // 3. Revoked-token retention. These rows are not just a blocklist: a 'superseded' row is what lets a
  // client's ORIGINAL emailed link keep resolving to their finished document (the live token was
  // rotated on signing), and 'declined'/'expired'/'withdrawn' rows are the only source of the precise
  // state once the token column is nulled. The old blanket 60-day purge turned every such link into
  // "invalid" two months after the fact. Signed-document links are meant to last (post-signing tokens
  // live 2 years), so 'superseded' rows are kept well past that; the rest for ~13 months.
  await run.step('prune revoked_tokens', async () => {
    const a = await (service as any).from('revoked_tokens').delete()
      .eq('reason', 'superseded').lt('revoked_at', iso(800))
    if (a.error) throw new Error(a.error.message)
    const b = await (service as any).from('revoked_tokens').delete()
      .neq('reason', 'superseded').lt('revoked_at', iso(400))
    if (b.error) throw new Error(b.error.message)
  })

  // 4. Rate-limit log (windows are minutes-to-hours; 30 days is generous).
  await run.step('prune portal_action_log', async () => {
    const { error } = await (service as any).from('portal_action_log').delete().lt('created_at', iso(30))
    if (error) throw new Error(error.message)
  })

  // 4b. Auth-attempt failure ledger (lib/auth/attempt-limit.ts, migration 064). Only the last five
  // minutes ever decide a lockout; a week is kept for investigations.
  await run.step('prune auth_attempts', async () => {
    const { error } = await (service as any).from('auth_attempts').delete().lt('created_at', iso(7))
    if (error) throw new Error(error.message)
  })

  // 4c. Step-up grants live 10 minutes (lib/auth/step-up.ts); session_seen feeds the 90-day
  // new-device comparison (lib/auth/session-seen.ts, migration 068) — keep a little longer than that.
  await run.step('prune step_up_grants', async () => {
    const { error } = await (service as any).from('step_up_grants').delete().lt('expires_at', iso(1))
    if (error) throw new Error(error.message)
  })
  await run.step('prune session_seen', async () => {
    const { error } = await (service as any).from('session_seen').delete().lt('first_seen_at', iso(100))
    if (error) throw new Error(error.message)
  })

  // 5a. Accounts deleted BEFORE deletion started banning the auth user are still able to sign in for
  // the rest of their 30-day window. Ban any that aren't (idempotent; only newly-banned are counted).
  await run.step('ban recently-deleted accounts', async () => {
    const recent = await fetchAll<any>('recently deleted users select', (from, to) =>
      (service as any).from('users').select('id')
        .not('deleted_at', 'is', null)
        .gte('deleted_at', iso(30))
        .order('id').range(from, to))
    for (const u of recent) {
      try {
        const banned = await isAuthUserBanned(service, u.id)
        if (banned !== false) continue // already banned, or couldn't tell — leave it
        const r = await banAuthUser(service, u.id)
        if (!r.ok) throw new Error(r.error)
        bannedLegacy++
      } catch (e) { run.rowError(`ban ${u.id}`, e) }
    }
  })

  // 5b. Erasure at day 30: auth record first, then the profile row. If the auth step fails the profile
  // row is left untouched so tomorrow's run retries (the row still matches the query).
  await run.step('anonymize deleted accounts', async () => {
    const candidates = await fetchAll<any>('anonymization candidates select', (from, to) =>
      (service as any).from('users').select('id')
        .not('deleted_at', 'is', null)
        .lt('deleted_at', iso(30))
        .not('email', 'like', 'deleted-%@deleted.scopegov.app')
        .order('id').range(from, to))

    // Never scrub someone who is currently an active member of a workspace: that is a live person whose
    // stale deleted_at was never cleared, and anonymizing them turns their name into "[Deleted user]" and
    // their notification/billing email into a dead address. Skip and log — a human should look.
    const active = new Set<string>()
    for (let i = 0; i < candidates.length; i += 100) {
      const ids = candidates.slice(i, i + 100).map((c: any) => c.id)
      const rows = await fetchAll<any>('active memberships select', (from, to) =>
        (service as any).from('workspace_members').select('id, user_id')
          .in('user_id', ids).eq('status', 'active').order('id').range(from, to))
      rows.forEach((r: any) => active.add(r.user_id))
    }

    for (const u of candidates) {
      try {
        if (active.has(u.id)) {
          skippedActive++
          console.warn(`[invite-cleanup] user ${u.id} has deleted_at set but is an active workspace member — NOT anonymized; review manually`)
          continue
        }
        const auth = await anonymizeAuthUser(service, u.id)
        if (!auth.ok) throw new Error(`auth anonymization failed: ${auth.error}`)

        // The profile photo is personal data in a public bucket at a guessable
        // path; clearing avatar_url alone would leave the image itself online.
        const avatarErr = await removeAvatarObjects(service, u.id)
        if (avatarErr) throw new Error(`avatar removal failed: ${avatarErr}`)

        const { error } = await (service as any).from('users').update({
          email:        anonymizedEmail(u.id),
          name:         '[Deleted user]',
          avatar_url:   null,
          updated_at:   now.toISOString(),
        }).eq('id', u.id)
        if (error) throw new Error(error.message)
        anonymized++
      } catch (e) { run.rowError(`anonymize ${u.id}`, e) }
    }
  })

  Object.assign(run.result, { purgedInvites, anonymizedUsers: anonymized, bannedLegacy, skippedActiveMembers: skippedActive })
  const { body, status } = await run.finish()
  return NextResponse.json(body, { status })
}

// Vercel Cron invokes the configured path with GET; the GitHub Actions backup uses POST.
export const GET = POST
