export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { generateBackupCodes } from '@/lib/utils/backup-codes'
import { sendMfaEnabledEmail } from '@/lib/email/templates'
import { resolveActiveWorkspaceId, resolveActorName } from '@/lib/auth/session'

// Single endpoint for both flows:
//  - Enrollment confirmation: no backup codes exist for this user yet →
//    on success we generate them, log it, email the user, and return the
//    codes once (they are never retrievable again).
//  - Login challenge / any repeat call: backup codes already exist → on
//    success the session is simply upgraded to aal2, nothing more to do.
//
// Whether to issue codes is decided from a DB read done AFTER verification
// succeeds — "does this user already have backup codes on file" — rather
// than from the TOTP factor's pre-verify status. That status check is
// racy against exactly the failure mode this endpoint used to hit: a
// request that verifies successfully server-side but then errors on its
// way back to the client (see the notifications-insert fix below) leaves
// the factor already 'verified' by the time a retry arrives, so a
// status-based check silently skips code generation on the retry — the
// codes exist in the database, but were never actually shown to the user.
// Checking DB existence instead makes this endpoint safe to retry.
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const { factorId, code } = body as { factorId?: string; code?: string }
    if (!factorId || !code) return NextResponse.json({ error: 'factorId and code are required' }, { status: 400 })

    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
    if (error) return NextResponse.json({ error: 'Incorrect code. Check your authenticator app and try again.' }, { status: 400 })

    // Verified — session is now aal2 regardless of which branch runs below.
    const service = createServiceClient()

    const { count: existingCodes } = await (service as any)
      .from('user_mfa_backup_codes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('used_at', null)

    if ((existingCodes || 0) > 0) {
      // Already has live backup codes — this was a login challenge, or a
      // retry of a completed enrollment. Nothing more to issue.
      return NextResponse.json({ ok: true })
    }

    // ── First-ever verification for this account — issue backup codes ────
    const { plaintext, hashes } = generateBackupCodes()
    const { error: insertErr } = await (service as any).from('user_mfa_backup_codes').insert(
      hashes.map(code_hash => ({ user_id: user.id, code_hash }))
    )
    // If we can't actually store the codes, don't hand plaintext ones to
    // the user for a set that doesn't exist server-side — surface a real
    // error instead of a false success.
    if (insertErr) throw insertErr

    const workspaceId = await resolveActiveWorkspaceId(service, user.id)
    // FIX (deep audit, Auth+MFA section — actor-name staleness): see
    // resolveActorName's own comment in lib/auth/session.ts.
    const actorName = await resolveActorName(service, user.id, user.user_metadata?.name || user.email!)

    // Everything below is best-effort (log/notify/email) — none of it
    // should cost the user their backup codes if it fails. BUG (fixed):
    // `.catch(() => {})` chained directly on a Supabase query builder
    // throws `TypeError: insert(...).catch is not a function` in this
    // runtime rather than swallowing the rejection — the exact same
    // failure class already fixed elsewhere for CO accept/close/withdraw
    // (commit fa95fe0). That crash was silently eating the backup-code
    // response on this route: codes got generated and stored just above,
    // then the request 500'd right after, so the client never received
    // them even though they existed in the database.
    try {
      await logAudit(service, {
        workspaceId: workspaceId || '',
        actorId: user.id, actorEmail: user.email!, actorName,
        eventType: 'security.mfa_enabled', entityType: 'user', entityId: user.id, entityName: user.email!,
        metadata: { factor_id: factorId },
      })
    } catch (e) { console.error('MFA enable audit log failed (non-fatal):', e) }

    try {
      await (service as any).from('notifications').insert({
        workspace_id: workspaceId,
        recipient_id: user.id,
        type: 'security', title: 'Two-factor authentication enabled',
        body: 'Your account now requires an authenticator code to sign in.',
      })
    } catch (e) { console.error('MFA enable notification insert failed (non-fatal):', e) }

    // FIX (re-audit): fire-and-forget email — not awaited — is unsafe in
    // serverless (the function can freeze/terminate right after the
    // response is sent, before the send completes). Same rule as
    // everywhere else in this codebase: await email sends, even inside a
    // .catch().
    await sendMfaEnabledEmail({ to: user.email!, name: actorName })
      .catch(e => console.error('MFA enable email failed (non-fatal):', e))

    return NextResponse.json({ ok: true, backupCodes: plaintext })
  } catch (err) {
    console.error('MFA verify error:', err)
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
  }
}

// audit_log.workspace_id is NOT NULL (it's a per-workspace record), but MFA
// is a user-level, cross-workspace action. We attribute the audit row to
// whichever workspace the user currently has active — reasonable, since
// that's the workspace context they were in when they made the change —
// without requiring workspace_id to be nullable and weakening every other
// query against a table whose whole job is being trustworthy.
//
// FIX (deep audit, RLS+permissions section): moved to lib/auth/session.ts
// and exported so change-password, DELETE /api/auth/mfa/factors,
// mfa/backup-codes, and password-changed can share the same fallback
// instead of each reimplementing (or, as it turned out, omitting) it.
