import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminAction } from '@/lib/auth/admin'
import { banAuthUser, isAnonymizedEmail } from '@/lib/utils/account-erasure'

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin({ requireStepUp: true })
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const { data: target } = await (service as any)
    .from('users').select('id, email, name, deleted_at, suspended_by_admin').eq('id', params.id).maybeSingle()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (!target.deleted_at) return NextResponse.json({ error: 'Not suspended' }, { status: 409 })

  // FIX (Admin panel independent audit — B3): invite-cleanup erases an account 30 days after deleted_at (new e-mail,
  // PII scrubbed, random password, MFA removed). Restoring that "succeeded": it unbanned an unusable zombie and told
  // the admin it was done. There is nothing left to restore.
  if (isAnonymizedEmail(target.email)) {
    return NextResponse.json({ error: 'This account was permanently erased and cannot be restored.', code: 'erased' }, { status: 409 })
  }

  // FIX (Admin panel independent audit — G4): users.deleted_at is also what the person's own "delete my account"
  // writes, and Restore used to undo that silently. Only an admin suspension restores on a plain click; anything
  // else needs explicit confirmation. (Suspensions made before suspended_by_admin existed read as "not by admin"
  // too, so they land here as well.)
  const body = await request.json().catch(() => ({})) as { confirmSelfDeleted?: unknown }
  const restoredSelfDeleted = !target.suspended_by_admin
  if (restoredSelfDeleted && body.confirmSelfDeleted !== true) {
    return NextResponse.json({
      error: 'This account was not suspended from the panel — the person deleted it themselves (or it was suspended before suspensions were tracked). Restoring brings the login back but NOT their workspace memberships. Confirm to restore anyway.',
      code: 'self_deleted',
    }, { status: 409 })
  }

  // 'none' is GoTrue's documented way to clear ban_duration immediately,
  // the same convention this codebase already relies on for banAuthUser's
  // ~100-year duration being reversible at all.
  const { error: unbanErr } = await (service as any).auth.admin.updateUserById(target.id, { ban_duration: 'none' })
  if (unbanErr) {
    console.error('[admin] unban auth user failed:', unbanErr.message)
    return NextResponse.json({ error: 'Could not restore this account' }, { status: 500 })
  }

  // Conditional on the account still being un-erased: the cron may have anonymized it between the read above and now.
  const { data: cleared, error } = await (service as any).from('users')
    .update({ deleted_at: null, suspended_by_admin: false, suspended_by_admin_at: null })
    .eq('id', target.id).not('deleted_at', 'is', null)
    .not('email', 'like', 'deleted-%@deleted.scopegov.app')
    .select('id')
  if (error) {
    console.error('[admin] clear user deleted_at failed:', error.message)
    return NextResponse.json({ error: 'Could not restore this account' }, { status: 500 })
  }
  if (!cleared || cleared.length === 0) {
    // Lost a race with erasure (or another restore). Put the ban back so an erased account is not left signable.
    const re = await banAuthUser(service, target.id)
    if (!re.ok) console.error('[admin] restore: could not re-ban after losing the race:', re.error)
    return NextResponse.json({ error: 'This account was erased or changed while restoring. Reload and check its state.', code: 'erased' }, { status: 409 })
  }

  const auditLogged = await logAdminAction(service, {
    actor, eventType: 'user.restored', targetType: 'user',
    targetId: target.id, targetLabel: target.email,
    metadata: restoredSelfDeleted ? { restoredSelfDeleted: true } : {},
  })

  return NextResponse.json({ ok: true, auditLogged })
}
