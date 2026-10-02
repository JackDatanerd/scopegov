export const runtime = 'nodejs'
// One sequential email + audit round trip per recipient — same unbounded shape payment-overdue carries.
export const maxDuration = 300

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { sendTrialWarningEmail } from '@/lib/email/templates'
import { getMembersWithPermission, filterByNotificationPreference } from '@/lib/utils/permissions-query'
import { notifyUsers } from '@/lib/utils/notify'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { insertAuditRow } from '@/lib/utils/audit'
import { CronRun, fetchAll } from '@/lib/utils/cron-run'

const DEAD_ADDRESS = /@deleted\.scopegov\.app$/i

// Daily, 08:00 UTC. Emails the people who can actually act on it (MANAGE_BILLING holders + the
// workspace creator) at 3, 2 and 1 days before a trial ends. payment-overdue's trial-expiry step
// (which runs an hour later) sends the day-0 email to the same audience.
//
// This used to email EVERY active member — including viewers and contractors, who cannot upgrade —
// while every other billing email (payment failed, subscription ended, day-0 trial expiry) already
// went to billing recipients only. It also lacked the dead-address filter.
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const service = createServiceClient()
  const run = new CronRun(service, 'trial-warning')
  let sent = 0

  await run.step('send trial warnings', async () => {
    const now       = new Date()
    const soon      = new Date(now.getTime() + 3 * 86400000).toISOString()
    const yesterday = new Date(now.getTime() - 86400000).toISOString()
    const today     = now.toISOString().slice(0, 10)

    const workspaces = await fetchAll<any>('trial-warning select', (from, to) =>
      (service as any).from('workspaces')
        .select(`id, agency_name, trial_ends_at, created_by,
          creator:users!workspaces_created_by_fkey(name, email),
          billing(paystack_subscription_code)`)
        .eq('plan_tier', 'trial')
        .is('deleted_at', null)
        .lte('trial_ends_at', soon)
        .gte('trial_ends_at', yesterday)
        .order('id')
        .range(from, to))

    for (const ws of workspaces) {
      try {
        // Already converting to a paid plan — no warning needed.
        if (ws.billing?.paystack_subscription_code) continue

        // Whole days remaining, rounded up: a trial ending in 30h reads as "2 days left".
        const daysLeft = Math.max(0, Math.ceil((new Date(ws.trial_ends_at).getTime() - now.getTime()) / 86400000))
        if (daysLeft <= 0) continue // already ended — payment-overdue's expiry step handles day 0

        // Who can act on it: everyone holding MANAGE_BILLING, plus the creator — but only while the
        // creator is STILL an active member. After an ownership transfer and departure they were
        // being warned about a workspace they no longer belong to.
        const allHolders = await getMembersWithPermission(service, ws.id, 'MANAGE_BILLING', 200)
        const holders = await filterByNotificationPreference(service, ws.id, 'trial_ending', allHolders)
        const audience = new Map<string, { id: string; name: string; email: string }>()
        for (const h of holders) audience.set(h.email.toLowerCase(), h)
        let creatorIsActive = false
        if (ws.created_by) {
          const { data: cm } = await (service as any).from('workspace_members').select('id')
            .eq('workspace_id', ws.id).eq('user_id', ws.created_by).eq('status', 'active').limit(1).maybeSingle()
          creatorIsActive = !!cm
        }
        if (creatorIsActive && ws.creator?.email && !audience.has(ws.creator.email.toLowerCase())) {
          const [creator] = await filterByNotificationPreference(service, ws.id, 'trial_ending',
            [{ id: ws.created_by, name: ws.creator.name, email: ws.creator.email }])
          if (creator) audience.set(creator.email.toLowerCase(), creator)
        }

        // The bell. `trial_ending` has always shown a Bell toggle in Settings, but nothing ever created
        // an in-app row for it, so the toggle did nothing. Once per workspace per calendar day (the
        // audit row is the dedupe key, like the emails below); each person's in-app preference and
        // the workspace default are applied by notifyUsers.
        // FIX (cron section 17, pass 4 — B5): a failed lookup used to read as "not sent yet" (only `data` was
        // destructured) and duplicated the bell / email on every run while audit_log kept failing.
        const { data: bellSent, error: bellErr } = await (service as any).from('audit_log').select('id')
          .eq('workspace_id', ws.id).eq('event_type', 'billing.trial_ending_bell')
          .eq('metadata->>day', today).limit(1).maybeSingle()
        if (bellErr) throw new Error(`bell dedupe lookup failed: ${bellErr.message}`)
        if (!bellSent) {
          const res = await notifyUsers(service, {
            workspaceId: ws.id,
            recipientIds: [...allHolders.map(h => h.id), creatorIsActive ? ws.created_by : null],
            type: 'trial_ending', eventType: 'trial_ending',
            title: daysLeft === 1 ? 'Your trial ends tomorrow' : `Your trial ends in ${daysLeft} days`,
            body: 'Choose a plan in Settings → Billing to keep your workspace running without interruption.',
            entityType: 'workspace', entityId: ws.id,
          })
          if (res.inserted) {
            const bellMarked = await insertAuditRow(service, {
              workspace_id: ws.id, actor_id: null,
              actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
              event_type: 'billing.trial_ending_bell', entity_type: 'workspace',
              entity_id: ws.id, entity_name: ws.agency_name,
              metadata: { days_left: daysLeft, day: today, recipients: res.recipients.length },
            })
            // FIX (cron section 17, independent pass 5 — B3): insertAuditRow reports failure by returning false. This row is the
            // once-per-day dedupe key for the bell, so a failed write means the bell repeats on any same-day re-run — say so.
            if (!bellMarked) run.rowError(`trial workspace ${ws.id}`, new Error('trial bell created but its dedupe audit row failed to write — a same-day re-run will repeat it'))
          }
        }

        for (const person of Array.from(audience.values())) {
          if (!person.email || DEAD_ADDRESS.test(person.email)) continue
          try {
            // One warning per person per CALENDAR DAY (a manual re-run must not double-send). A rolling 24h
            // window made a run at 08:00:10 skip someone whose row was written at 08:00:40 yesterday.
            // FIX (cron section 17, pass 4 — B2): this dedupe key was the recipient's EMAIL, stored in the audit
            // row's metadata (`sent_to`). audit_log is append-only and erase_user_pii never reached metadata, so
            // an erased person's real address stayed in the log for the life of the workspace. The key is now the
            // user id (migration 127 rewrites the rows already written).
            const { data: alreadySent, error: sentErr } = await (service as any).from('audit_log').select('id')
              .eq('workspace_id', ws.id)
              .eq('event_type', 'billing.trial_ending_soon')
              .eq('metadata->>user_id', person.id)
              .eq('metadata->>day', today)
              .limit(1).maybeSingle()
            if (sentErr) throw new Error(`warning dedupe lookup failed: ${sentErr.message}`)
            if (alreadySent) continue

            const delivery = await sendTrialWarningEmail({
              to:         person.email,
              name:       person.name || person.email,
              agencyName: ws.agency_name,
              daysLeft,
              upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing`,
            })
            // A rejected send is not a sent warning: the audit row below is also the dedupe key.
            if (!delivery.ok) { console.error('Trial warning email rejected:', delivery.error); continue }
            const warnMarked = await insertAuditRow(service, {
              workspace_id: ws.id, actor_id: null,
              actor_email: 'cron@scopegov.app', actor_name: 'ScopeGov',
              event_type: 'billing.trial_ending_soon', entity_type: 'workspace',
              entity_id: ws.id, entity_name: ws.agency_name,
              metadata: { days_left: daysLeft, user_id: person.id, day: today },
            })
            // FIX (cron section 17, independent pass 5 — B3): same as the bell above — this row is the per-person-per-day dedupe key.
            if (!warnMarked) run.rowError(`trial warning ${ws.id} → user ${person.id}`, new Error('warning sent but its dedupe audit row failed to write — a same-day re-run will resend it'))
            sent++
          } catch (e) { run.rowError(`trial warning ${ws.id} → user ${person.id}`, e) }
        }
      } catch (e) { run.rowError(`trial workspace ${ws.id}`, e) }
    }
    run.result.sent = sent
  })

  const { body, status } = await run.finish()
  return NextResponse.json(body, { status })
}

// Vercel Cron invokes the configured path with GET; the GitHub Actions backup uses POST.
export const GET = POST
