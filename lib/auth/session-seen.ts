// lib/auth/session-seen.ts
//
// New-device sign-in alerts. The first time the APP sees a session
// (getSession(), i.e. the first authenticated request — an attacker who only
// talks to GoTrue gets nothing from the data, so the first app request is the
// moment that matters), it is recorded in public.session_seen. If the person has
// been seen before but never from this browser/OS family (last 90 days), and the
// sign-in itself is fresh, they get an email + in-app notification + audit row.
//
// Best-effort: never throws, never blocks a request beyond one indexed upsert
// per session per server instance (an in-memory set short-circuits repeats).

import { createHash } from 'crypto'
import { decodeJwtPayload, lastAuthenticatedAtSeconds } from '@/lib/auth/auth-time'
import { stepUpSessionKey } from '@/lib/auth/step-up'
import { logSecurityAudit } from '@/lib/auth/security-audit'
import { notifySecurityEvent } from '@/lib/utils/notify'
import { sendNewSignInEmail } from '@/lib/email/templates'

const KNOWN_WINDOW_DAYS = 90
/** A session first seen long after it was created (deploy day, cold cache) is registered silently. */
const ALERT_IF_SIGNED_IN_WITHIN_SECONDS = 15 * 60

const seen = new Set<string>()
const SEEN_MAX = 5000

export function describeUserAgent(ua: string | null | undefined): { device: string; key: string } {
  const s = ua || ''
  const browser =
    /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' :
    /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : s ? 'Browser' : 'Unknown browser'
  const os =
    /Windows/.test(s) ? 'Windows' : /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' :
    /Mac OS X|Macintosh/.test(s) ? 'macOS' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : 'Unknown OS'
  const device = `${browser} on ${os}`
  return { device, key: createHash('sha256').update(device).digest('hex').slice(0, 24) }
}

export async function registerSessionSeen(args: {
  service: any
  supabase: any
  user: { id: string; email?: string | null; user_metadata?: any }
  name: string
  workspaceId: string
  headers: { get(name: string): string | null }
  appUrl?: string
}): Promise<void> {
  try {
    const { service, supabase, user, headers } = args
    const { data: { session } } = await supabase.auth.getSession()
    const payload = decodeJwtPayload(session?.access_token)
    const sessionKey = stepUpSessionKey(payload, user.id)
    if (seen.has(sessionKey)) return
    if (seen.size >= SEEN_MAX) seen.clear()
    seen.add(sessionKey)

    const xff = headers.get('x-forwarded-for')
    const ip = (xff ? xff.split(',')[0].trim() : headers.get('x-real-ip')) || null
    const ua = headers.get('user-agent')
    const { device, key } = describeUserAgent(ua)

    const { data: existingRows } = await service
      .from('session_seen').select('session_id, device_key, first_seen_at')
      .eq('user_id', user.id)
      .gte('first_seen_at', new Date(Date.now() - KNOWN_WINDOW_DAYS * 86400_000).toISOString())
      .limit(200)
    const rows = (existingRows || []) as Array<{ session_id: string; device_key: string | null }>
    if (rows.some(r => r.session_id === sessionKey)) return

    const { error } = await service.from('session_seen').insert({
      session_id: sessionKey, user_id: user.id, ip, user_agent: (ua || '').slice(0, 300), device_key: key,
    })
    if (error) return // a concurrent request registered it first

    const hadPrior = rows.length > 0
    const knownDevice = rows.some(r => r.device_key === key)
    const signedInAt = lastAuthenticatedAtSeconds(payload)
    const fresh = signedInAt !== null && Math.floor(Date.now() / 1000) - signedInAt <= ALERT_IF_SIGNED_IN_WITHIN_SECONDS
    if (!hadPrior || knownDevice || !fresh || !user.email) return

    const when = new Date(((signedInAt as number) || Math.floor(Date.now() / 1000)) * 1000).toUTCString()
    await logSecurityAudit(service, {
      actorId: user.id, actorEmail: user.email, actorName: args.name,
      eventType: 'security.new_device_login', entityId: user.id, entityName: user.email,
      metadata: { device, ip, source: 'app' }, allWorkspaces: false, fallbackWorkspaceId: args.workspaceId,
    })
    await notifySecurityEvent(service, user.id, 'New sign-in to your account',
      `Signed in from ${device}${ip ? ` (${ip})` : ''}. If that wasn't you, sign out everywhere from Settings.`)
    await sendNewSignInEmail({
      to: user.email, name: args.name, when, ip, device,
      settingsUrl: `${args.appUrl || process.env.NEXT_PUBLIC_APP_URL || ''}/settings?tab=account`,
    }).catch(e => console.error('New sign-in email failed (non-fatal):', e))
  } catch (err) {
    console.error('registerSessionSeen failed (non-fatal):', err)
  }
}
