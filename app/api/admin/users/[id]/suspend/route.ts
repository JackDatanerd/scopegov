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

  const body = await request.json().catch(() => ({})) as { reason?: string }
  const reason = (body.reason || '').trim().slice(0, 500)

  const banResult = await banAuthUser(service, target.id)
  if (!banResult.ok) {
    console.error('[admin] ban auth user failed:', banResult.error)
    return NextResponse.json({ error: 'Could not suspend this account' }, { status: 500 })
  }

  const { error } = await (service as any)
    .from('users').update({ deleted_at: new Date().toISOString() }).eq('id', target.id)
  if (error) {
    console.error('[admin] mark user deleted_at failed:', error.message)
    return NextResponse.json({ error: 'Could not suspend this account' }, { status: 500 })
  }

  await (service as any).rpc('revoke_user_sessions', { p_user: target.id, p_except: null }).catch(() => {})

  await logAdminAction(service, {
    actor, eventType: 'user.suspended', targetType: 'user',
    targetId: target.id, targetLabel: target.email,
    metadata: { reason: reason || null },
  })

  return NextResponse.json({ ok: true })
}
