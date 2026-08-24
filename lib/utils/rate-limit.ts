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
