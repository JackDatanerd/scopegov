import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'
import { banAuthUser } from '@/lib/utils/account-erasure'

// Deliberately NOT the same path as self-service account/delete (which
// walks the user out of every workspace one at a time via
// leave_workspace_atomic, so it can never orphan one). An admin suspension
// is usually urgent (abuse, fraud, a support escalation) and must not be
// blocked by "you're the last MANAGE_ROLES holder in workspace X" the way
// a voluntary departure correctly is — so this only bans the auth record
// and marks deleted_at; it does NOT touch workspace_members at all. A
// suspended solo-workspace owner's workspace is untouched and still
// visible in Admin > Workspaces if it needs separate handling.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin({ requireStepUp: true })
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const { data: target } = await (service as any)
    .from('users').select('id, email, name, is_platform_admin, deleted_at').eq('id', params.id).maybeSingle()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.id === actor.id) return NextResponse.json({ error: 'You cannot suspend your own account' }, { status: 400 })
  if (target.is_platform_admin) return NextResponse.json({ error: 'Cannot suspend another platform admin from here' }, { status: 400 })
  if (target.deleted_at) return NextResponse.json({ error: 'Already suspended' }, { status: 409 })

  const body = await request.json().catch(() => ({})) as { reason?: unknown }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''

  const banResult = await banAuthUser(service, target.id)
  if (!banResult.ok) {
    console.error('[admin] ban auth user failed:', banResult.error)
    return NextResponse.json({ error: 'Could not suspend this account' }, { status: 500 })
  }

  // Conditional on deleted_at IS NULL so two admins suspending at once cannot both "win". suspended_by_admin is what
  // lets Restore tell this apart from the person deleting their own account, and keeps invite-cleanup from erasing
  // the account after 30 days (Admin panel audit — G4/B3).
  const now = new Date().toISOString()
  const { data: marked, error } = await (service as any)
    .from('users')
    .update({ deleted_at: now, suspended_by_admin: true, suspended_by_admin_at: now })
    .eq('id', target.id).is('deleted_at', null)
    .select('id')
  if (error) {
    console.error('[admin] mark user suspended failed:', error.message)
    return NextResponse.json({ error: 'Could not suspend this account' }, { status: 500 })
  }
  if (!marked || marked.length === 0) {
    return NextResponse.json({ error: 'Already suspended' }, { status: 409 })
  }

  // FIX (Admin panel independent audit — B2): this was `await rpc(...).catch(() => {})`. supabase-js query builders
  // are thenables with no .catch(), so it threw a TypeError AFTER the ban and deleted_at were applied: every user
  // suspension answered 500, never reached logAdminAction (no audit row) and never sent the revoke request. The
  // outcome is now read from `{ error }` like every other rpc call here; a failed revoke does not undo the
  // suspension (the ban already stops refresh) but is reported so the admin can run "Sign out of all sessions".
  const { error: revokeErr } = await (service as any).rpc('revoke_user_sessions', { p_user: target.id, p_except: null })
  if (revokeErr) console.error('[admin] suspend: session revoke failed (non-fatal):', revokeErr.message)

  const auditLogged = await logAdminAction(service, {
    actor, eventType: 'user.suspended', targetType: 'user',
    targetId: target.id, targetLabel: target.email,
    metadata: { reason: reason || null, sessionsRevoked: !revokeErr },
  })

  return NextResponse.json({ ok: true, sessionsRevoked: !revokeErr, auditLogged })
}
