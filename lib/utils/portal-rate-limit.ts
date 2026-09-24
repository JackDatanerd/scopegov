// lib/utils/portal-rate-limit.ts
//
// FEATURE (portal audit, section 18): see migration 030. Same sliding-
// window shape as lib/utils/rate-limit.ts's AI-cost limiter, keyed by
// client IP (getClientIp) instead of user_id since these routes have no
// authenticated session — the token in the URL IS the auth, and rate-
// limiting by token alone wouldn't help against a script working through
// a list of tokens from one source. Deliberately generous: a real client
// signing/responding to a real document will never come close to these
// limits, even accounting for retries on a flaky connection.
//
// Usage in a route handler, right after extracting `token` and before any
// DB work:
//
//   const ip = getClientIp(request)
//   const limited = await checkPortalRateLimit(service, ip, 'sow.sign')
//   if (!limited.allowed)
//     return NextResponse.json({ error: limited.message }, { status: 429 })
//   ... rest of the handler ...

export interface PortalRateLimitResult {
  allowed: boolean
  message?: string
}

const LIMITS: Record<string, { max: number; windowMinutes: number }> = {
  'sow.sign':            { max: 10, windowMinutes: 10 },
  'sow.decline':         { max: 10, windowMinutes: 10 },
  'sow.requestChanges':  { max: 10, windowMinutes: 10 },
  'co.accept':           { max: 10, windowMinutes: 10 },
  'co.counter':          { max: 10, windowMinutes: 10 },
  'co.countersign':      { max: 10, windowMinutes: 10 },
  'co.decline':          { max: 10, windowMinutes: 10 },
  // FEATURE (portal audit, section 18): new client-facing mutating action —
  // same coverage requirement as every entry above it.
  'invoice.dispute':     { max: 10, windowMinutes: 10 },
  'invoice.paid':        { max: 10, windowMinutes: 10 },
  // Read-only, but each request renders a PDF (CPU-heavy) for an unauthenticated link holder — an
  // unthrottled loop of them is a cheap way to burn function time. Generous enough that a person
  // downloading and re-downloading never notices.
  'sow.pdf':             { max: 30, windowMinutes: 10 },
  'co.pdf':              { max: 30, windowMinutes: 10 },
  'invoice.pdf':         { max: 30, windowMinutes: 10 },
}
const DEFAULT_LIMIT = { max: 10, windowMinutes: 10 }

export async function checkPortalRateLimit(
  service: any, ip: string | undefined, routeKey: string
): Promise<PortalRateLimitResult> {
  // No IP available (e.g. local dev, or a proxy stripping headers) — fail
  // open rather than lock out real clients over infra we don't control.
  if (!ip) return { allowed: true }

  const { max, windowMinutes } = LIMITS[routeKey] || DEFAULT_LIMIT
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()

  const { count, error } = await service
    .from('portal_action_log')
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip)
    .eq('route_key', routeKey)
    .gte('created_at', since)

  // Fail open on a DB error — a broken rate-limit check should never block
  // a real client from signing or responding to a real document.
  if (error) {
    console.error('Portal rate limit check failed (failing open):', error)
    return { allowed: true }
  }

  if ((count || 0) >= max) {
    return {
      allowed: false,
      message: 'Too many attempts — please wait a few minutes and try again.',
    }
  }
  return { allowed: true }
}

export async function recordPortalAction(
  service: any, ip: string | undefined, routeKey: string
): Promise<void> {
  if (!ip) return
  const { error } = await service
    .from('portal_action_log')
    .insert({ ip, route_key: routeKey })
  if (error) console.error('Failed to record portal action:', error)
}
