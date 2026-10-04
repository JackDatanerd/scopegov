import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'
import { activeWorkspaceIdsForUser } from '@/lib/auth/security-audit'
import { logAudit } from '@/lib/utils/audit'
import { notifySecurityEvent } from '@/lib/utils/notify'
import { sendMfaDisabledEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'
import { clearMfaCodeLockouts } from '@/lib/auth/attempt-limit'

// Platform-level counterpart to app/api/team/[id]/reset-mfa/route.ts — same
// underlying mechanics (delete the TOTP factor(s) via the admin API, spend
// any outstanding backup codes, revoke sessions, notify the person), but
// reachable without holding MANAGE_ROLES in any one of the user's
// workspaces, and with no permission-ceiling check against the actor
// (a platform admin outranks every workspace role by construction). Use
// this for a user who isn't reachable through any workspace's own Team tab
// — e.g. a solo trial account with no other member who could act on them.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin({ requireStepUp: true })
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const { data: target, error: targetErr } = await (service as any)
    .from('users').select('id, email, name, deleted_at').eq('id', params.id).maybeSingle()
  if (targetErr) {
    console.error('[admin] reset-mfa: user read failed:', targetErr.message)
    return NextResponse.json({ error: 'Could not load this user' }, { status: 500 })
  }
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: factorsData, error: listErr } = await (service as any).auth.admin.mfa.listFactors({ userId: target.id })
  if (listErr) {
    console.error('[admin] listFactors failed:', listErr.message)
    return NextResponse.json({ error: 'Could not read this user\u2019s MFA factors' }, { status: 500 })
  }
  const totpFactors = (factorsData?.factors || []).filter((f: any) => f.factor_type === 'totp')
  if (totpFactors.length === 0) {
    return NextResponse.json({ error: 'This user has no two-factor authentication enrolled.' }, { status: 400 })
  }

  for (const f of totpFactors) {
    const { error: delErr } = await (service as any).auth.admin.mfa.deleteFactor({ id: f.id, userId: target.id })
    if (delErr) {
      console.error('[admin] deleteFactor failed:', delErr.message)
      return NextResponse.json({ error: 'Could not remove this user\u2019s MFA factor' }, { status: 500 })
    }
  }

  await (service as any).from('user_mfa_backup_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', target.id).is('used_at', null)

  // Pass 9: the strikes belonged to the factor that was just removed — don't lock the replacement enrolment.
  await clearMfaCodeLockouts(service, target.id)

  const { error: revokeErr } = await (service as any).rpc('revoke_user_sessions', { p_user: target.id, p_except: null })
  if (revokeErr) console.error('[admin] MFA reset: session revoke failed (non-fatal):', revokeErr.message)

  // MFA belongs to the person, not to any one workspace — tell every
  // workspace this user belongs to, same as the workspace-level route does,
  // without naming which admin (there isn't one here — it was the platform).
  try {
    const workspaceIds = await activeWorkspaceIdsForUser(service, target.id)
    await Promise.all(workspaceIds.map(workspaceId => logAudit(service, {
      workspaceId, actorId: null, actorEmail: '', actorName: 'ScopeGov platform support',
      eventType: 'security.mfa_reset_by_admin', entityType: 'user',
      entityId: target.id, entityName: target.name || target.email,
      metadata: { via: 'platform_admin_reset' },
      // The actor is deliberately anonymous ("ScopeGov platform support"): do not stamp the staff member's own IP
      // onto a row the customer can read and export.
      omitClientIp: true,
    })))
  } catch (e) {
    console.error('[admin] MFA reset: per-workspace audit failed (non-fatal):', e)
  }

  await notifySecurityEvent(service, target.id, 'Two-factor authentication was reset',
    'ScopeGov support reset your two-factor authentication and signed you out everywhere. Set it up again on your next sign-in.')
    .catch(() => {})

  const delivery = await checkedSend(
    () => sendMfaDisabledEmail({ to: target.email, name: target.name || target.email, via: 'platform_support' }),
    'platform admin MFA reset notice',
  )
  if (!delivery.ok) console.error('[admin] MFA reset email failed (non-fatal):', delivery.error)

  const auditLogged = await logAdminAction(service, {
    actor,
    eventType: 'user.mfa_reset',
    targetType: 'user',
    targetId: target.id,
    targetLabel: target.email,
    metadata: { factorsRemoved: totpFactors.length, sessionsRevoked: !revokeErr, emailSent: delivery.ok },
  })

  return NextResponse.json({ ok: true, auditLogged, emailSent: delivery.ok, sessionsRevoked: !revokeErr })
}
