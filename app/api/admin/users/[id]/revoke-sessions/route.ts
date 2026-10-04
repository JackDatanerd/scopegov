import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'
import { activeWorkspaceIdsForUser } from '@/lib/auth/security-audit'
import { logAudit } from '@/lib/utils/audit'
import { notifySecurityEvent } from '@/lib/utils/notify'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin({ requireStepUp: true })
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const { data: target, error: targetErr } = await (service as any)
    .from('users').select('id, email, name').eq('id', params.id).maybeSingle()
  if (targetErr) {
    console.error('[admin] revoke-sessions: user read failed:', targetErr.message)
    return NextResponse.json({ error: 'Could not load this user' }, { status: 500 })
  }
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const { data: revokedCount, error } = await (service as any)
    .rpc('revoke_user_sessions', { p_user: target.id, p_except: null })
  if (error) {
    console.error('[admin] revoke sessions failed:', error.message)
    return NextResponse.json({ error: 'Could not revoke sessions' }, { status: 500 })
  }

  try {
    const workspaceIds = await activeWorkspaceIdsForUser(service, target.id)
    await Promise.all(workspaceIds.map(workspaceId => logAudit(service, {
      workspaceId, actorId: null, actorEmail: '', actorName: 'ScopeGov platform support',
      eventType: 'security.other_sessions_revoked', entityType: 'user',
      entityId: target.id, entityName: target.name || target.email,
      metadata: { via: 'platform_admin' },
      omitClientIp: true, // see reset-mfa: the staff member's IP must not land in the customer's audit log
    })))
  } catch (e) {
    console.error('[admin] revoke sessions: per-workspace audit failed (non-fatal):', e)
  }

  await notifySecurityEvent(service, target.id, 'You were signed out everywhere',
    'ScopeGov support signed your account out of every active session as a precaution.').catch(() => {})

  const auditLogged = await logAdminAction(service, {
    actor,
    eventType: 'user.sessions_revoked',
    targetType: 'user',
    targetId: target.id,
    targetLabel: target.email,
    metadata: { sessionsRevoked: revokedCount ?? null },
  })

  return NextResponse.json({ ok: true, sessionsRevoked: revokedCount ?? null, auditLogged })
}
