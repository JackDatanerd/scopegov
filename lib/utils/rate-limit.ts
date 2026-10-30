// lib/utils/rate-limit.ts
//
// FIX (audit round 3, finding #4): AI-cost routes had no rate limiting at
// all. This is a simple Postgres-backed sliding-window limiter — see
// supabase/migrations/012_ai_rate_limits.sql for why no external
// Redis/Upstash dependency was introduced for this.
//
// Usage in a route handler, after auth/permission checks and before the
// Anthropic call:
//
//   const limited = await checkAiRateLimit(service, session.id, 'sow.generate')
//   if (!limited.allowed)
//     return NextResponse.json({ error: limited.message }, { status: 429 })
//   ... make the AI call ...
//   await recordAiUsage(service, session.workspaceId, session.id, 'sow.generate')

import { AI_DRAFT_ROUTE_KEYS, entitlementsFor, planDisplayName } from '@/lib/billing/entitlements'
import { effectivePlanTier } from '@/lib/billing/plans'

export interface RateLimitResult {
  allowed: boolean
  message?: string
  /**
   * Why a call was refused: 'burst' = too many in a few minutes (retry shortly), 'allowance' = the plan's monthly AI drafts are
   * used up. Drafting routes that have a no-AI path (SOW generation) use it to carry on without the model instead of refusing.
   */
  reason?: 'burst' | 'allowance'
  /**
   * AI drafting routes only, on an allowed claim: call it when the model call FAILED or produced nothing usable, so the customer's
   * monthly allowance is not spent on a draft they never got. The row stays in the log, so the burst limit (the abuse backstop)
   * still counts the attempt; only the allowance count lets it go.
   */
  refund?: () => Promise<void>
}

// Per-route limits: (max calls, window in minutes). Deliberately generous —
// this is a cost/abuse backstop, not a product-facing throttle. A real
// workspace doing normal document work will never come close.
const LIMITS: Record<string, { max: number; windowMinutes: number }> = {
  'sow.parseBrief':        { max: 20, windowMinutes: 10 },
  'sow.generate':          { max: 10, windowMinutes: 10 },
  'sow.regenerateSection': { max: 30, windowMinutes: 10 },
  'co.draft':              { max: 20, windowMinutes: 10 },
  'invoice.draft':         { max: 20, windowMinutes: 10 },
  'guardian.check':        { max: 40, windowMinutes: 10 },
  // FIX (audit round 6): inbound email checks run the same embedding +
  // classification pipeline as guardian.check but have no user_id to key
  // on (triggered by the inbound email webhook, not a session) — see checkAiRateLimitByProject.
  'guardian.inbound':      { max: 30, windowMinutes: 10 },
}
const DEFAULT_LIMIT = { max: 20, windowMinutes: 10 }

export async function checkAiRateLimit(
  service: any, userId: string, routeKey: string
): Promise<RateLimitResult> {
  const { max, windowMinutes } = LIMITS[routeKey] || DEFAULT_LIMIT
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()

  const { count, error } = await service
    .from('ai_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('route_key', routeKey)
    .gte('created_at', since)

  // Fail open on a DB error here — a broken rate-limit check should never
  // take down the underlying feature, only best-effort throttle it.
  if (error) {
    console.error('Rate limit check failed (failing open):', error)
    return { allowed: true }
  }

  if ((count || 0) >= max) {
    return {
      allowed: false,
      message: `Too many requests — please wait a few minutes and try again (limit: ${max} per ${windowMinutes}m).`,
    }
  }
  return { allowed: true }
}

export async function recordAiUsage(
  service: any, workspaceId: string, userId: string, routeKey: string,
  opts: { countsTowardAllowance?: boolean } = {},
): Promise<void> {
  // An INTERNAL retry (the model's reply failed validation and the route asks again) is real cost and still counts toward the
  // burst limit, but it is not something the customer asked for, so it must not spend their monthly allowance.
  const row: Record<string, unknown> = { workspace_id: workspaceId, user_id: userId, route_key: routeKey }
  if (opts.countsTowardAllowance === false) row.allowance_bucket = 'none'
  let { error } = await service.from('ai_usage_log').insert(row)
  if (error && opts.countsTowardAllowance === false && isMissingBucketColumn(error)) {
    ;({ error } = await service.from('ai_usage_log').insert({ workspace_id: workspaceId, user_id: userId, route_key: routeKey }))
  }
  if (error) console.error('Failed to record AI usage:', error)
}

/** Migration 169 not applied yet (code deployed first): Postgres 42703 undefined_column naming allowance_bucket. */
function isMissingBucketColumn(error: any): boolean {
  return error?.code === '42703' || /allowance_bucket/i.test(String(error?.message || ''))
}


// ── Monthly AI drafting allowance ─────────────────────────────────────────────────────────────────────────────────────
// Each plan includes a number of AI drafts per calendar month (UTC): PLAN_ENTITLEMENTS[plan].aiDraftsPerMonth, counted across
// the five drafting routes in AI_DRAFT_ROUTE_KEYS. This sits behind the burst limits above (which stop a loop) and answers a
// different question (what a plan includes), so a Solo workspace can no longer run an open-ended model bill at $39 a month.
// Guardian is deliberately NOT metered monthly: a refused check is a scope flag that never gets raised, which is the one
// failure the product exists to prevent. It keeps only its burst limits.

const DRAFT_ROUTES: ReadonlySet<string> = new Set(AI_DRAFT_ROUTE_KEYS)

export function isAiDraftRoute(routeKey: string): boolean {
  return DRAFT_ROUTES.has(routeKey)
}

/** The current calendar month in UTC: [start, nextStart). The allowance resets at nextStart. */
export function aiDraftMonthWindow(now: Date = new Date()): { start: Date; resetsAt: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  }
}

export function aiDraftQuotaMessage(planName: string, limit: number, resetsAt: Date): string {
  const when = resetsAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
  return `This workspace has used the ${limit.toLocaleString('en-US')} AI drafts included in the ${planName} plan this month. The allowance resets on ${when} (UTC). Upgrade in Settings \u2192 Billing for more, or write this part by hand.`
}

export interface AiDraftUsage { used: number; limit: number; resetsAt: string }

/** AI drafts this workspace has used this month against its plan's allowance; null on a failed read (callers fail open). */
export async function getAiDraftUsage(service: any, workspaceId: string, planTier: string, now: Date = new Date()): Promise<AiDraftUsage | null> {
  const { start, resetsAt } = aiDraftMonthWindow(now)
  // Each row is tagged with the allowance it belongs to when it is written (migration 169): 'trial' while on the trial, 'paid'
  // on a paid plan, 'none' for an internal retry or a refunded failure. The trial's usage is its own allowance and does NOT
  // follow the workspace onto its first paid month (a trialist who used 100 drafts was locked out of Solo's 60 the day they paid).
  const { count, error } = await service
    .from('ai_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('allowance_bucket', planTier === 'trial' ? 'trial' : 'paid')
    .in('route_key', [...AI_DRAFT_ROUTE_KEYS])
    .gte('created_at', start.toISOString())
  if (error) { console.error('AI draft usage read failed:', error); return null }
  return { used: count || 0, limit: entitlementsFor(planTier).aiDraftsPerMonth, resetsAt: resetsAt.toISOString() }
}

/**
 * Verifies the monthly allowance AFTER the caller's usage row is inserted (claim first, verify after, like the burst limit): the
 * count includes the caller's own row, so more than the allowance means this call is the one over it. Fails OPEN on a database
 * error, like every limiter here.
 */
async function overMonthlyDraftAllowance(service: any, workspaceId: string, plan: string): Promise<{ over: boolean; message?: string }> {
  try {
    const usage = await getAiDraftUsage(service, workspaceId, plan)
    if (!usage) return { over: false }
    if (usage.used <= usage.limit) return { over: false }
    return { over: true, message: aiDraftQuotaMessage(planDisplayName(plan), usage.limit, new Date(usage.resetsAt)) }
  } catch (e) {
    // A broken allowance check must never take drafting down: the burst limit above has already passed.
    console.error('Monthly AI allowance check threw (failing open):', e)
    return { over: false }
  }
}

/** The workspace's EFFECTIVE plan for allowance purposes; null on any failure (the allowance then fails open). */
async function readAllowancePlan(service: any, workspaceId: string): Promise<string | null> {
  try {
    const { data: ws, error } = await service.from('workspaces').select('plan_tier, trial_ends_at').eq('id', workspaceId).maybeSingle()
    if (error || !ws) { if (error) console.error('Monthly AI allowance: workspace read failed (failing open):', error); return null }
    return effectivePlanTier(ws.plan_tier, ws.trial_ends_at)
  } catch (e) {
    console.error('Monthly AI allowance: workspace read threw (failing open):', e)
    return null
  }
}

/**
 * FIX (CO logic, independent pass 6): claim a rate-limit slot ATOMICALLY instead of check-then-record.
 *
 * checkAiRateLimit + recordAiUsage are two separate statements with the (slow, paid) model call between them, so a burst
 * of parallel requests all read the same under-the-limit count, all passed, and only then each recorded itself — the
 * limit did not bound a concurrent burst at all (simulated: 40 simultaneous requests against a limit of 20 made 40
 * model calls). Recording just before the call only narrows that to one round trip, which a simultaneous burst still fits
 * inside. This claims first and verifies after: insert the usage row, then count the window INCLUDING it, and if the
 * count is over the limit, withdraw that row and refuse. However many requests race, the rows that survive are at most
 * `max`, so at most `max` calls proceed.
 *
 * Trade-offs, deliberately accepted: (1) a burst that goes over the limit is refused as a whole, including the requests
 * that would individually have fit — it only ever hurts the burst, never a user working within the limit; (2) the slot
 * is consumed even if the model call later fails (the call may still have been billed, and a failing call must not be a
 * free retry loop). Like the other limiters it fails OPEN on a database error — a broken limiter must not take the
 * feature down.
 */
export async function claimAiRateSlot(
  service: any, workspaceId: string, userId: string, routeKey: string
): Promise<RateLimitResult> {
  const { max, windowMinutes } = LIMITS[routeKey] || DEFAULT_LIMIT
  const isDraft = isAiDraftRoute(routeKey)
  // Drafting routes tag the row with the allowance it spends (see getAiDraftUsage); the plan is read first so the tag is right.
  const plan = isDraft ? await readAllowancePlan(service, workspaceId) : null
  const base = { workspace_id: workspaceId, user_id: userId, route_key: routeKey }
  let { data: row, error: insertError } = await service
    .from('ai_usage_log')
    .insert(isDraft ? { ...base, allowance_bucket: plan === 'trial' ? 'trial' : 'paid' } : base)
    .select('id')
    .single()
  if (insertError && isDraft && isMissingBucketColumn(insertError)) {
    // Code deployed before migration 169: keep the burst limiter working (the monthly count then fails open below).
    ;({ data: row, error: insertError } = await service.from('ai_usage_log').insert(base).select('id').single())
  }
  if (insertError || !row) {
    console.error('Rate limit claim failed (failing open):', insertError)
    return { allowed: true }
  }

  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()
  const { count, error: countError } = await service
    .from('ai_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('route_key', routeKey)
    .gte('created_at', since)
  if (countError) {
    console.error('Rate limit check failed (failing open):', countError)
    return { allowed: true }
  }

  if ((count || 0) > max) {
    // Over the limit: give the slot back so a refused request does not eat into the window.
    const { error: releaseError } = await service.from('ai_usage_log').delete().eq('id', row.id)
    if (releaseError) console.error('Failed to release an unused AI rate-limit slot:', releaseError)
    return {
      allowed: false,
      reason: 'burst',
      message: `Too many requests — please wait a few minutes and try again (limit: ${max} per ${windowMinutes}m).`,
    }
  }

  // Monthly allowance for the drafting routes (see above). Over it: withdraw this row so a refused call does not use the
  // allowance, and say when it resets.
  if (isDraft) {
    const monthly = plan ? await overMonthlyDraftAllowance(service, workspaceId, plan) : { over: false as const }
    if (monthly.over) {
      const { error: releaseError } = await service.from('ai_usage_log').delete().eq('id', row.id)
      if (releaseError) console.error('Failed to release an unused AI allowance slot:', releaseError)
      return { allowed: false, reason: 'allowance', message: monthly.message }
    }
    return {
      allowed: true,
      refund: async () => {
        const { error: refundError } = await service.from('ai_usage_log').update({ allowance_bucket: 'none' }).eq('id', row.id)
        if (refundError) console.error('Failed to refund an AI allowance slot:', refundError)
      },
    }
  }
  return { allowed: true }
}

/**
 * FIX (independent pass 10, section 13 - B2): project-keyed twin of claimAiRateSlot, for the Guardian inbound-email path.
 * guardian/inbound used checkAiRateLimitByProject -> (paid embedding) -> recordAiUsageByProject: the same check-then-record
 * shape claimAiRateSlot's header describes, so a burst of parallel deliveries to one project address (the address is
 * effectively unauthenticated) all read an under-the-limit count and all made paid calls. Claim first, verify after: insert
 * the usage row, count the window INCLUDING it, and withdraw it and refuse when over. Same trade-offs as claimAiRateSlot
 * (a refused burst is refused whole; the slot stays used if the call later fails; fails OPEN on a database error).
 */
export async function claimAiRateSlotByProject(
  service: any, workspaceId: string, projectId: string, routeKey: string
): Promise<RateLimitResult> {
  const { max, windowMinutes } = LIMITS[routeKey] || DEFAULT_LIMIT
  const { data: row, error: insertError } = await service
    .from('ai_usage_log')
    .insert({ workspace_id: workspaceId, project_id: projectId, route_key: routeKey })
    .select('id')
    .single()
  if (insertError || !row) {
    console.error('Rate limit claim failed (failing open):', insertError)
    return { allowed: true }
  }

  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()
  const { count, error: countError } = await service
    .from('ai_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('route_key', routeKey)
    .gte('created_at', since)
  if (countError) {
    console.error('Rate limit check failed (failing open):', countError)
    return { allowed: true }
  }

  if ((count || 0) > max) {
    const { error: releaseError } = await service.from('ai_usage_log').delete().eq('id', row.id)
    if (releaseError) console.error('Failed to release an unused AI rate-limit slot:', releaseError)
    return {
      allowed: false,
      message: `Too many inbound checks for this project — please wait a few minutes (limit: ${max} per ${windowMinutes}m).`,
    }
  }
  return { allowed: true }
}

// FIX (audit round 6): project-keyed variants for AI calls made with no
// authenticated user in context (e.g. the Guardian inbound-email webhook).
// Same sliding-window approach as the user-keyed functions above, just
// keyed on project_id instead of user_id.
export async function checkAiRateLimitByProject(
  service: any, projectId: string, routeKey: string
): Promise<RateLimitResult> {
  const { max, windowMinutes } = LIMITS[routeKey] || DEFAULT_LIMIT
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()

  const { count, error } = await service
    .from('ai_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .eq('route_key', routeKey)
    .gte('created_at', since)

  if (error) {
    console.error('Rate limit check failed (failing open):', error)
    return { allowed: true }
  }

  if ((count || 0) >= max) {
    return {
      allowed: false,
      message: `Too many inbound checks for this project — please wait a few minutes (limit: ${max} per ${windowMinutes}m).`,
    }
  }
  return { allowed: true }
}

export async function recordAiUsageByProject(
  service: any, workspaceId: string, projectId: string, routeKey: string
): Promise<void> {
  const { error } = await service
    .from('ai_usage_log')
    .insert({ workspace_id: workspaceId, project_id: projectId, route_key: routeKey })
  if (error) console.error('Failed to record AI usage:', error)
}

// FIX (deep audit, Team & Invites re-pass — feature gap): invite creation
// (api/team/invite POST) sends a real outbound email to an arbitrary
// address and is reachable by anyone holding just INVITE_MEMBERS — a
// permission a narrowly-scoped custom role can hold with nothing else.
// Every other cost- or abuse-bearing action in the app (every route
// above, every portal action in portal-rate-limit.ts) already has a
// sliding-window backstop; invite creation never did, so an
// invite→revoke→re-invite loop (or just inviting many distinct
// addresses, bounded only by the seat limit on Pro/Agency plans) could
// spam ScopeGov's own transactional email sender at an arbitrary
// address, with nothing here to slow it down. Keyed on workspace_id
// rather than actor — the concern is the workspace's outbound email
// volume regardless of which member is doing the inviting — using the
// audit_log rows invite creation already writes (event_type
// 'member.invited'), so this needs no new table or migration.
const INVITE_LIMIT = { max: 15, windowMinutes: 10 }

export async function checkInviteRateLimit(
  service: any, workspaceId: string
): Promise<RateLimitResult> {
  const since = new Date(Date.now() - INVITE_LIMIT.windowMinutes * 60 * 1000).toISOString()

  const { count, error } = await service
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    // FIX (deep audit, Team & Invites section): counts BOTH invite events.
    // api/team/[id]/resend also sends real email to an arbitrary address,
    // so leaving it uncounted would have left an unmetered path to the
    // very thing this limiter exists to bound — and resending is the
    // cheaper action to repeat, since it needs no new row.
    .in('event_type', ['member.invited', 'member.invite_resent'])
    .gte('created_at', since)

  // Fail open on a DB error — a broken rate-limit check should never
  // block a real admin from inviting a real teammate.
  if (error) {
    console.error('Invite rate limit check failed (failing open):', error)
    return { allowed: true }
  }

  if ((count || 0) >= INVITE_LIMIT.max) {
    return {
      allowed: false,
      message: `Too many invites sent recently — please wait a few minutes and try again (limit: ${INVITE_LIMIT.max} per ${INVITE_LIMIT.windowMinutes}m).`,
    }
  }
  return { allowed: true }
}
