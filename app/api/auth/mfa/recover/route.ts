export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { notifySecurityEvent } from '@/lib/utils/notify'
import { hashBackupCode } from '@/lib/utils/backup-codes'
import { sendMfaDisabledEmail } from '@/lib/email/templates'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'
import {
  checkAuthAttemptLimit, recordAuthFailure, clearAuthFailures, lockoutMessage, AUTH_ATTEMPT_LIMIT,
} from '@/lib/auth/attempt-limit'

// POST /api/auth/mfa/recover — sign in with a one-time backup code when the
// authenticator is lost. Deliberately blunt: a successful recovery REMOVES the
// user's TOTP factor(s) and every remaining backup code, revokes all other
// sessions, and sends them back through MFA setup.
//
// FIX (build — Auth independent audit): several gaps closed here —
//  - throttled per user (5 failures / 5 min) and failed attempts are audited;
//  - the code is claimed with a conditional UPDATE, so two concurrent requests
//    can't both spend the same code;
//  - factor deletion errors used to be ignored: the code was burned, the audit
//    row said `factor_removed`, and the user was left with the factor still in
//    place and no code to get in. A failure now restores the code and reports it;
//  - the session's cached user is refreshed after the factors are removed, so
//    nothing keeps demanding a challenge no factor can satisfy;

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => null) as { code?: unknown } | null
    if (typeof body?.code !== 'string' || !body.code.trim()) {
      return NextResponse.json({ error: 'Backup code is required' }, { status: 400 })
    }
    if (body.code.length > 40) {
      return NextResponse.json({ error: 'That backup code is invalid or has already been used.' }, { status: 400 })
    }

    const service = createServiceClient()

    const limit = await checkAuthAttemptLimit(service, user.id, 'mfa_recover')
    if (!limit.allowed) {
      return NextResponse.json(
        { error: lockoutMessage(limit.retryAfterSeconds), code: 'locked', retryAfterSeconds: limit.retryAfterSeconds },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
      )
    }

    const workspaceId = await resolveActiveWorkspaceId(service, user.id)
    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)

    const hash = hashBackupCode(body.code)
    const { data: match } = await (service as any)
      .from('user_mfa_backup_codes')
      .select('id')
      .eq('user_id', user.id)
      .eq('code_hash', hash)
      .is('used_at', null)
      .maybeSingle()

    // Claim it atomically: only the request whose UPDATE actually flips
    // used_at from NULL gets to proceed.
    let claimed = false
    if (match) {
      const { data: claimRows } = await (service as any)
        .from('user_mfa_backup_codes')
        .update({ used_at: new Date().toISOString() })
        .eq('id', match.id).is('used_at', null)
        .select('id')
      claimed = (claimRows || []).length === 1
    }

    if (!claimed) {
      await recordAuthFailure(service, user.id, 'mfa_recover')
      const after = await checkAuthAttemptLimit(service, user.id, 'mfa_recover')
      try {
        await logAudit(service, {
          workspaceId: workspaceId || '',
          actorId: user.id, actorEmail: user.email!, actorName,
          eventType: 'security.mfa_recovery_failed', entityType: 'user', entityId: user.id, entityName: user.email!,
          metadata: { failures_in_window: after.failures, locked: !after.allowed, window_seconds: AUTH_ATTEMPT_LIMIT.windowSeconds },
        })
      } catch (e) { console.error('MFA recovery-failure audit log failed (non-fatal):', e) }
      return NextResponse.json({ error: 'That backup code is invalid or has already been used.' }, { status: 400 })
    }

    // Remove every factor (verified or half-enrolled) via the admin API.
    const { data: factorList } = await supabase.auth.mfa.listFactors()
    for (const f of (factorList?.all || [])) {
      const { error: delErr } = await (service as any).auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id })
      if (delErr) {
        console.error('MFA recovery: could not delete factor', f.id, delErr.message)
        // Give the code back — otherwise the user is locked out with a burned code.
        await (service as any).from('user_mfa_backup_codes').update({ used_at: null }).eq('id', match.id)
        return NextResponse.json({ error: 'Recovery could not be completed. Your backup code was not used — please try again.' }, { status: 500 })
      }
    }

    await clearAuthFailures(service, user.id, 'mfa_recover')

    const { error: retireErr } = await (service as any).from('user_mfa_backup_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', user.id).is('used_at', null)
    if (retireErr) console.error('MFA recovery: could not retire remaining codes:', retireErr.message)

    const { error: othersErr } = await supabase.auth.signOut({ scope: 'others' })
    if (othersErr) console.error('MFA recovery session revocation failed (non-fatal):', othersErr.message)

    // Re-issue this session's tokens so its cached user no longer lists the
    // factor(s) that were just deleted.
    const { error: refreshErr } = await supabase.auth.refreshSession()
    if (refreshErr) console.error('MFA recovery session refresh failed (non-fatal):', refreshErr.message)

    try {
      await logAudit(service, {
        workspaceId: workspaceId || '',
        actorId: user.id, actorEmail: user.email!, actorName,
        eventType: 'security.mfa_backup_code_used', entityType: 'user', entityId: user.id, entityName: user.email!,
        metadata: { result: 'factor_removed' },
      })
    } catch (e) { console.error('MFA recovery audit log failed (non-fatal):', e) }

    // One row per active membership, with the error actually read (upstream helper).
    await notifySecurityEvent(service, user.id, 'Signed in with a backup code',
      'Two-factor authentication was reset using a backup code. Set it up again to keep your account protected.')

    await sendMfaDisabledEmail({ to: user.email!, name: actorName, via: 'backup_code_recovery' })
      .catch(e => console.error('MFA recovery email failed (non-fatal):', e))

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('MFA recover error:', err)
    return NextResponse.json({ error: 'Recovery failed' }, { status: 500 })
  }
}
