import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin({ requireStepUp: true })
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const { data: target } = await (service as any)
    .from('users').select('id, email, name, deleted_at').eq('id', params.id).maybeSingle()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (!target.deleted_at) return NextResponse.json({ error: 'Not suspended' }, { status: 409 })

  // 'none' is GoTrue's documented way to clear ban_duration immediately,
  // the same convention this codebase already relies on for banAuthUser's
  // ~100-year duration being reversible at all.
  const { error: unbanErr } = await (service as any).auth.admin.updateUserById(target.id, { ban_duration: 'none' })
  if (unbanErr) {
    console.error('[admin] unban auth user failed:', unbanErr.message)
    return NextResponse.json({ error: 'Could not restore this account' }, { status: 500 })
  }

  const { error } = await (service as any).from('users').update({ deleted_at: null }).eq('id', target.id)
  if (error) {
    console.error('[admin] clear user deleted_at failed:', error.message)
    return NextResponse.json({ error: 'Could not restore this account' }, { status: 500 })
  }

  await logAdminAction(service, {
    actor, eventType: 'user.restored', targetType: 'user',
    targetId: target.id, targetLabel: target.email,
  })

  return NextResponse.json({ ok: true })
}
