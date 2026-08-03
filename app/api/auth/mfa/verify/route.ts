export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { generateBackupCodes } from '@/lib/utils/backup-codes'
import { sendMfaEnabledEmail } from '@/lib/email/templates'

// Single endpoint for both flows:
//  - Enrollment confirmation: factor is currently "unverified" → on success
//    we generate backup codes, log it, email the user, and return the codes
//    once (they are never retrievable again).
//  - Login challenge: factor is already "verified" → on success the
//    session is simply upgraded to aal2 (challengeAndVerify refreshes the
//    session and our cookie-writing server client persists that).
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const { factorId, code } = body as { factorId?: string; code?: string }
    if (!factorId || !code) return NextResponse.json({ error: 'factorId and code are required' }, { status: 400 })

    const { data: factors } = await supabase.auth.mfa.listFactors()
    const factor = (factors?.all || []).find(f => f.id === factorId && f.factor_type === 'totp')
    if (!factor) return NextResponse.json({ error: 'Unknown factor' }, { status: 404 })
    const isEnrollment = factor.status === 'unverified'

    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
    if (error) return NextResponse.json({ error: 'Incorrect code. Check your authenticator app and try again.' }, { status: 400 })

    if (!isEnrollment) {
      // Login challenge — session is now aal2. Nothing more to do.
      return NextResponse.json({ ok: true })
    }

    // ── Enrollment confirmed — issue backup codes, this is a one-time reveal ──
    const service = createServiceClient()
    const { plaintext, hashes } = generateBackupCodes()
    await (service as any).from('user_mfa_backup_codes').insert(
      hashes.map(code_hash => ({ user_id: user.id, code_hash }))
    )

    await logAudit(service, {
      workspaceId: (await resolveActiveWorkspaceId(service, user.id)) || '',
      actorId: user.id, actorEmail: user.email!, actorName: user.user_metadata?.name || user.email!,
      eventType: 'security.mfa_enabled', entityType: 'user', entityId: user.id, entityName: user.email!,
      metadata: { factor_id: factorId },
    })

    await (service as any).from('notifications').insert({
      workspace_id: await resolveActiveWorkspaceId(service, user.id),
      recipient_id: user.id,
      type: 'security', title: 'Two-factor authentication enabled',
      body: 'Your account now requires an authenticator code to sign in.',
    }).catch(() => {})

    sendMfaEnabledEmail({ to: user.email!, name: user.user_metadata?.name || user.email! }).catch(() => {})

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
async function resolveActiveWorkspaceId(service: any, userId: string): Promise<string | null> {
  const { data } = await service.from('users').select('active_workspace_id').eq('id', userId).maybeSingle()
  if (data?.active_workspace_id) return data.active_workspace_id
  const { data: member } = await service.from('workspace_members')
    .select('workspace_id').eq('user_id', userId).eq('status', 'active')
    .order('created_at', { ascending: true }).limit(1).maybeSingle()
  return member?.workspace_id || null
}
