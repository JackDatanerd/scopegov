export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { notifySecurityEvent } from '@/lib/utils/notify'
import { backupCodeCandidateHashes } from '@/lib/utils/backup-codes'
import { sendMfaDisabledEmail, sendAccountLockedEmail } from '@/lib/email/templates'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'
import {
  beginAuthAttempt, releaseAuthAttempt, clearAuthFailures, clearMfaCodeLockouts, lockedResponseBody, AUTH_ATTEMPT_LIMIT,
} from '@/lib/auth/attempt-limit'
import { logSecurityAudit } from '@/lib/auth/security-audit'

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

    // Atomic reservation — see lib/auth/attempt-limit.ts. It counts as a failure
    // unless released below or cleared on success.
    const begin = await beginAuthAttempt(service, user.id, 'mfa_recover')
    if (!begin.allowed) {
      return NextResponse.json(lockedResponseBody(begin), { status: 429, headers: { 'Retry-After': String(begin.retryAfterSeconds) } })
    }

    const workspaceId = await resolveActiveWorkspaceId(service, user.id)
    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)

    // Peppered HMAC (current) OR legacy unsalted sha256 — codes issued before the
    // change keep working (lib/utils/backup-codes.ts).
    // FIX (Auth+MFA pass 9 — LOW): the lookup's and the claim's `error` were never read, so a
    // transient database failure on a perfectly valid, unspent code was scored as a WRONG code — a
    // strike, a `mfa_recovery_failed` audit row, and \"invalid or already used\" — the same
    // transient-failure-reported-as-a-user-mistake gap pass 8 closed for listFactors. A failed lookup
    // or claim is now an availability error: the reservation is released and nothing is spent.
    const { data: matchRows, error: matchErr } = await (service as any)
      .from('user_mfa_backup_codes')
      .select('id')
      .eq('user_id', user.id)
      .in('code_hash', backupCodeCandidateHashes(body.code))
      .is('used_at', null)
      .limit(1)
    if (matchErr) {
      console.error('MFA recovery: backup-code lookup failed:', matchErr.message)
      await releaseAuthAttempt(service, begin.attemptId)
      return NextResponse.json({ error: 'Recovery could not be completed. Your backup code was not used — please try again.' }, { status: 502 })
    }
    const match = (matchRows || [])[0] || null

    // Claim it atomically: only the request whose UPDATE actually flips
    // used_at from NULL gets to proceed.
    let claimed = false
    if (match) {
      const { data: claimRows, error: claimErr } = await (service as any)
        .from('user_mfa_backup_codes')
        .update({ used_at: new Date().toISOString() })
        .eq('id', match.id).is('used_at', null)
        .select('id')
      if (claimErr) {
        console.error('MFA recovery: backup-code claim failed:', claimErr.message)
        await releaseAuthAttempt(service, begin.attemptId)
        return NextResponse.json({ error: 'Recovery could not be completed. Your backup code was not used — please try again.' }, { status: 502 })
      }
      claimed = (claimRows || []).length === 1
    }

    if (!claimed) {
      const locked = begin.failures >= AUTH_ATTEMPT_LIMIT.maxFailures
      try {
        await logAudit(service, {
          workspaceId: workspaceId || '',
          actorId: user.id, actorEmail: user.email!, actorName,
          eventType: 'security.mfa_recovery_failed', entityType: 'user', entityId: user.id, entityName: user.email!,
          metadata: { failures_in_window: begin.failures, locked, window_seconds: AUTH_ATTEMPT_LIMIT.windowSeconds },
        })
        // FEATURE (deep audit, Auth+MFA section — feature gap): see
        // mfa/verify's own comment — same gap, same fix, same "once per
        // lockout, not per guess" firing point.
        if (locked) {
          await notifySecurityEvent(service, user.id, 'Repeated failed sign-in attempts',
            'Several wrong backup codes were entered in a row. Sign-in has been temporarily locked as a precaution.')
          await sendAccountLockedEmail({ to: user.email!, name: actorName, context: 'backup_code' })
            .catch(e => console.error('Account-locked email failed (non-fatal):', e))
        }
      } catch (e) { console.error('MFA recovery-failure audit log failed (non-fatal):', e) }
      return NextResponse.json({ error: 'That backup code is invalid or has already been used.' }, { status: 400 })
    }

    // Remove every factor (verified or half-enrolled) via the admin API.
    // FIX (Auth+MFA pass 8 — MEDIUM): listFactors()'s `error` was never read, so a transient
    // failure left `factorList` undefined, the loop below ran ZERO times, and the route
    // carried on as if the factors were gone — spending the code, retiring every other
    // code, signing out the other sessions, writing a `factor_removed` audit row and
    // answering ok while the authenticator was still enrolled: a person who had lost it
    // was left with no code and no way in. Same give-the-code-back path as a failed delete.
    const { data: factorList, error: listErr } = await supabase.auth.mfa.listFactors()
    if (listErr) {
      console.error('MFA recovery: could not list factors:', listErr.message)
      await (service as any).from('user_mfa_backup_codes').update({ used_at: null }).eq('id', match.id)
      await releaseAuthAttempt(service, begin.attemptId)
      return NextResponse.json({ error: 'Recovery could not be completed. Your backup code was not used — please try again.' }, { status: 502 })
    }
    for (const f of (factorList?.all || [])) {
      const { error: delErr } = await (service as any).auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id })
      if (delErr) {
        console.error('MFA recovery: could not delete factor', f.id, delErr.message)
        // Give the code back — otherwise the user is locked out with a burned code.
        await (service as any).from('user_mfa_backup_codes').update({ used_at: null }).eq('id', match.id)
        await releaseAuthAttempt(service, begin.attemptId)
        return NextResponse.json({ error: 'Recovery could not be completed. Your backup code was not used — please try again.' }, { status: 500 })
      }
    }

    await clearAuthFailures(service, user.id, 'mfa_recover')
    await clearMfaCodeLockouts(service, user.id)

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

    await logSecurityAudit(service, {
      actorId: user.id, actorEmail: user.email!, actorName,
      eventType: 'security.mfa_backup_code_used', entityId: user.id, entityName: user.email!,
      metadata: { result: 'factor_removed' }, fallbackWorkspaceId: workspaceId,
    })

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
