export const runtime = 'nodejs'
export const maxDuration = 120

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { verifyCronSecret } from '@/lib/utils/verify-cron'
import { sendEmail } from '@/lib/email/send'
import { systemFrom } from '@/lib/email/from'
import { alertCronFailure } from '@/lib/utils/cron-alert'
import { recordCronHeartbeat } from '@/lib/utils/cron-heartbeat'
import { reclassifyCheck, GUARDIAN_SYSTEM_ACTOR, MAX_AUTO_CLASSIFICATION_ATTEMPTS } from '@/lib/ai/guardian-pipeline'
import { recordAiUsageByProject } from '@/lib/utils/rate-limit'

// FIX (audit round 3): local copy replaced with the shared,
// null-safe helper — see lib/utils/verify-cron.ts.

// FIX (build, cron section): this whole route detected real problems
// (elevated classification-failure rate, unresolved failures sitting for
// 24h+) but only ever `console.error`d them — literally commented "Could
// also POST to a Slack webhook here". Nobody was actually paged. This
// isn't scoped to a single workspace (it's a platform-wide health check
// across every workspace's guardian_checks), so it can't go through the
// normal per-workspace notification system — it needs its own ops
// recipient. OPS_ALERT_EMAIL is optional; if unset this still degrades to
// the previous console.error-only behavior rather than crashing the cron.

// FIX (cron audit, section 17 — closing pass): returns whether the send
// actually succeeded. `shouldAlert` below used to mark the cooldown as
// "sent" the instant it decided to alert — before this function even
// attempted delivery — so a Resend failure (bad API key, an outage) still
// consumed the full cooldown window as if the page had gone out. The
// entire point of this route (per the FIX above it) is that someone
// actually gets paged; silently eating the next 1-6 hours of alerts on a
// delivery failure defeats that just as thoroughly as never emailing at
// all did before this route existed.
async function alertOps(subject: string, lines: string[]): Promise<boolean> {
  const to = process.env.OPS_ALERT_EMAIL
  if (!to) return false
  // FIX (Notifications & email fix round): the try/catch that used to wrap
  // this could never fire — Resend's SDK resolves `{ error }` instead of
  // throwing — so this always returned true and the cooldown above was
  // consumed by sends that never went out, exactly what the note above says
  // it prevents. sendEmail() reports the real outcome.
  const res = await sendEmail({
    from:    systemFrom('ScopeGov Ops'),
    to,
    subject: `[Guardian Health] ${subject}`,
    html: `<div style="font-family:monospace;white-space:pre-wrap;">${lines.map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('\n')}</div>`,
  })
  if (!res.ok) console.error('Guardian health ops alert email failed:', res.error)
  return res.ok
}

// FIX (cron audit, section 17): this route runs every 15 minutes and had
// no cooldown on either alert — an issue that stays elevated/unresolved
// re-triggered a fresh ops email every single run for as long as it lasted,
// unlike every other recurring notification in this codebase. `key` is a
// stable per-alert-type identifier (this route only has two); `cooldownMs`
// caps how often that specific alert can actually fire an email, while the
// console.error above it still logs every run either way, so nothing about
// server-side visibility is lost — only the inbox spam is.
//
// FIX (cron audit, section 17 — closing pass): split into a read-only
// cooldown check and a separate `markAlerted` write, called only after
// alertOps() reports success — see that function's comment. A failed send
// now leaves the cooldown state untouched, so the very next run (15
// minutes later) tries again instead of going quiet for up to 6 hours.
async function isOnCooldown(service: any, key: string, cooldownMs: number): Promise<boolean> {
  const { data } = await service.from('ops_alert_state').select('last_sent_at').eq('key', key).maybeSingle()
  return !!(data && Date.now() - new Date(data.last_sent_at).getTime() < cooldownMs)
}

async function markAlerted(service: any, key: string): Promise<void> {
  await service.from('ops_alert_state').upsert({ key, last_sent_at: new Date().toISOString() })
}

const SWEEP_BATCH = 10               // AI calls per run (cost + duration bound)
const SWEEP_BUDGET_MS = 90_000       // stop starting new work after this
const SWEEP_MAX_AGE_DAYS = 90        // don't resurrect very old backlog
const BACKOFF_BASE_MS = 15 * 60000   // 15m, 30m, 60m, … per failed attempt

function groupByWorkspace(rows: Array<{ workspace_id: string }>): string {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.workspace_id, (counts.get(r.workspace_id) || 0) + 1)
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([ws, n]) => `  workspace ${ws}: ${n}`).join('\n')
}

// FEATURE (independent pass, section 13): this cron used to only PAGE on classification
// failures. Nothing ever retried them automatically, and checks stored `pending` because no SOW
// was signed at submission time (or because the inbound rate limit was hit) were stranded
// forever — retry only handled classification_failed, by hand. The sweep below re-classifies
// both kinds in place (bounded per run, exponential backoff, capped attempts).
async function sweepUnclassified(service: any) {
  const now = Date.now()
  const oldest = new Date(now - SWEEP_MAX_AGE_DAYS * 86400000).toISOString()
  const cols = 'id, workspace_id, project_id, classification_failed, classification_attempts, last_attempt_at, created_at'

  const { data: failedRows, error: failedErr } = await service.from('guardian_checks').select(cols)
    .eq('outcome', 'pending').eq('is_duplicate', false).eq('classification_failed', true)
    .lt('classification_attempts', MAX_AUTO_CLASSIFICATION_ATTEMPTS).gte('created_at', oldest)
    .order('created_at', { ascending: true }).limit(40)
  if (failedErr) throw new Error(`guardian sweep (failed): ${failedErr.message}`)

  // Backlog: pending, never failed, and the project NOW has a signed-SOW snapshot.
  const { data: backlogRows, error: backlogErr } = await service.from('guardian_checks')
    .select(`${cols}, projects!inner(project_scope_snapshot!inner(id))`)
    .eq('outcome', 'pending').eq('is_duplicate', false).eq('classification_failed', false)
    .lt('classification_attempts', MAX_AUTO_CLASSIFICATION_ATTEMPTS).gte('created_at', oldest)
    .order('created_at', { ascending: true }).limit(40)
  if (backlogErr) throw new Error(`guardian sweep (backlog): ${backlogErr.message}`)

  const due = (r: any) => {
    if (!r.last_attempt_at) return true
    const wait = BACKOFF_BASE_MS * Math.pow(2, Number(r.classification_attempts || 0))
    return now - new Date(r.last_attempt_at).getTime() >= wait
  }
  const candidates = [...(failedRows || []), ...(backlogRows || [])].filter(due).slice(0, SWEEP_BATCH)

  const started = Date.now()
  // FIX (independent pass round 2, section 13): `duplicates` is a new bucket — reclassifyCheck
  // did not used to dedup at all on this path, so there was never a status here to distinguish
  // from a plain skip. Counted separately so a run that resolves a pile of backlog duplicates
  // (e.g. the same forwarded email arriving several times before a SOW was signed) is visible as
  // exactly that, not indistinguishable from checks that were simply ineligible this round.
  const stats = { candidates: candidates.length, classified: 0, flagged: 0, failed: 0, duplicates: 0, skipped: 0 }
  for (const c of candidates) {
    if (Date.now() - started > SWEEP_BUDGET_MS) break
    try {
      await recordAiUsageByProject(service, c.workspace_id, c.project_id, 'guardian.sweep')
      const res = await reclassifyCheck(service, c.id, {
        actor: GUARDIAN_SYSTEM_ACTOR, auditEvent: 'check.swept', emailPath: 'automatic re-check',
        requireFailed: false, maxAttempts: MAX_AUTO_CLASSIFICATION_ATTEMPTS,
      })
      if (res.status === 'classified') { stats.classified++; if (res.flagId) stats.flagged++ }
      else if (res.status === 'failed') stats.failed++
      else if (res.status === 'duplicate') stats.duplicates++
      else stats.skipped++
    } catch (e) {
      stats.failed++
      console.error('Guardian sweep item failed:', c.id, e)
    }
  }
  return stats
}

export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const service  = createServiceClient() as any
    const since15m = new Date(Date.now() - 15 * 60000).toISOString()

    // FIX (independent pass, section 13): the failure rate used to be computed in JS over an
    // unpaginated row select (silently capped at PostgREST's 1,000 rows) and its denominator
    // included checks that were never classifiable at all (pending because no SOW was signed),
    // which diluted the rate and could hide a real outage. Exact counts over classifiable checks only.
    const windowBase = () => service.from('guardian_checks')
      .select('id', { count: 'exact', head: true }).gte('created_at', since15m).eq('is_duplicate', false)
    const [{ count: totalCount, error: totalErr }, { count: failedCount, error: failedCountErr }] = await Promise.all([
      windowBase().or('classification_failed.eq.true,outcome.neq.pending'),
      windowBase().eq('classification_failed', true),
    ])
    if (totalErr) throw new Error(`guardian-health total: ${totalErr.message}`)
    if (failedCountErr) throw new Error(`guardian-health failed: ${failedCountErr.message}`)

    const total  = totalCount || 0
    const failed = failedCount || 0
    const rate   = total > 0 ? failed / total : 0

    if (rate > 0.01 && total >= 5) {
      const { data: failedRows } = await service.from('guardian_checks').select('workspace_id')
        .gte('created_at', since15m).eq('is_duplicate', false).eq('classification_failed', true).limit(500)
      const msg = `Classification failure rate: ${(rate * 100).toFixed(1)}% (${failed}/${total} in last 15 min)`
      console.error(`[GUARDIAN ALERT] ${msg}`)
      if (!(await isOnCooldown(service, 'guardian_health:elevated_failure_rate', 60 * 60000))) {
        if (await alertOps('Elevated classification failure rate', [msg, 'By workspace:', groupByWorkspace(failedRows || [])]))
          await markAlerted(service, 'guardian_health:elevated_failure_rate')
      }
    }

    // ── Sweep: retry failed + classify the backlog ────────────
    let sweep: Awaited<ReturnType<typeof sweepUnclassified>> | { error: string } = { candidates: 0, classified: 0, flagged: 0, failed: 0, duplicates: 0, skipped: 0 }
    try { sweep = await sweepUnclassified(service) }
    catch (e) { console.error('Guardian sweep error:', e); sweep = { error: e instanceof Error ? e.message : 'sweep failed' } }

    // Alert on failures that are still unresolved after 24h (auto-retries included — a check
    // only stays here once the sweep has exhausted its attempts, or the outage is ongoing).
    const since24h = new Date(Date.now() - 24 * 3600000).toISOString()
    const { count: unresolvedCount, error: unresolvedErr } = await (service as any)
      .from('guardian_checks')
      .select('id', { count: 'exact', head: true })
      .eq('classification_failed', true)
      .lt('created_at', since24h)
      .eq('outcome', 'pending')
    // FIX (cron/portal audit round 3): the error was never read, so a failed count looked like "0
    // unresolved failures" — the alert this query exists to raise silently could never fire while the
    // query was failing, and the heartbeat still said healthy. Fail the run (alert + no heartbeat).
    if (unresolvedErr) throw new Error(`guardian-health unresolved-failures count: ${unresolvedErr.message}`)

    if ((unresolvedCount || 0) > 0) {
      const { data: stuckRows } = await service.from('guardian_checks').select('workspace_id')
        .eq('classification_failed', true).eq('outcome', 'pending').lt('created_at', since24h).limit(500)
      const msg = `${unresolvedCount} unresolved classification failures older than 24h`
      console.error(`[GUARDIAN ALERT] ${msg}`)
      if (!(await isOnCooldown(service, 'guardian_health:unresolved_failures', 6 * 3600000))) {
        if (await alertOps('Unresolved classification failures', [msg, 'By workspace:', groupByWorkspace(stuckRows || [])]))
          await markAlerted(service, 'guardian_health:unresolved_failures')
      }
    }

    await recordCronHeartbeat(service, 'guardian-health', { total, failed, sweep })
    return NextResponse.json({ ok: true, total, failed, rate: rate.toFixed(3), sweep })
  } catch (err) {
    console.error('Guardian health check error:', err)
    await alertCronFailure(createServiceClient(), 'guardian-health', err).catch(() => {})
    return NextResponse.json({ error: 'Cron failed' }, { status: 500 })
  }
}

// FIX (cron): Vercel Cron Jobs invoke the configured path with a GET
// request, not POST — every route here only exported POST, so all 6 jobs
// wired up in vercel.json would 405 the moment Vercel actually triggered
// them. Exporting GET as an alias makes both invocation paths work.
//
// FIX (cron audit, section 17 re-pass): the paragraph this replaces claimed
// sow-stall/co-stall/guardian-health were "now scheduled directly in
// vercel.json" — vercel.json is actually `{}` (confirmed on disk); the
// primary scheduler is the external scopegov-cron-worker (Cloudflare
// Worker, not in this repo), with .github/workflows/vercel-crons.yml kept
// as a redundant trigger. That comment was stale and pointed anyone
// debugging "why didn't this cron run" at a file that controls nothing.
export const GET = POST
