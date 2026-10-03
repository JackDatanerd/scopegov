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

export interface RateLimitResult {
  allowed: boolean
  message?: string
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
  // on (triggered by Postmark, not a session) — see checkAiRateLimitByProject.
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
  service: any, workspaceId: string, userId: string, routeKey: string
): Promise<void> {
  const { error } = await service
    .from('ai_usage_log')
    .insert({ workspace_id: workspaceId, user_id: userId, route_key: routeKey })
  if (error) console.error('Failed to record AI usage:', error)
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
  const { data: row, error: insertError } = await service
    .from('ai_usage_log')
    .insert({ workspace_id: workspaceId, user_id: userId, route_key: routeKey })
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
      message: `Too many requests — please wait a few minutes and try again (limit: ${max} per ${windowMinutes}m).`,
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
