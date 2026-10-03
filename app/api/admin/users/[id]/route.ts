import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminRead, loadAdminHistory } from '@/lib/auth/admin'
import { isAuthUserBanned, isAnonymizedEmail } from '@/lib/utils/account-erasure'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin()
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  // A malformed id would reach Postgres as an invalid uuid and come back as a 500 that looks like an outage.
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const [userRes, membershipsRes, factorsRes, banned, history] = await Promise.all([
    (service as any).from('users').select('id, email, name, is_platform_admin, created_at, deleted_at, suspended_by_admin, suspended_by_admin_at').eq('id', params.id).maybeSingle(),
    (service as any)
      .from('workspace_members')
      .select('id, status, created_at, workspace_id, workspaces:workspace_id (id, name, agency_name, plan_tier, deleted_at), roles:role_id (name)')
      .eq('user_id', params.id)
      .order('created_at', { ascending: true }),
    (service as any).auth.admin.mfa.listFactors({ userId: params.id }),
    isAuthUserBanned(service, params.id),
    loadAdminHistory(service, 'user', params.id),
  ])

  // FIX (Admin panel independent audit — B5/B7): a failed read used to be reported as "User not found", a failed
  // ban lookup (null) as "Normal", and a failed listFactors as "Not enrolled" — which also disabled Reset MFA.
  // Unknown is now reported as unknown (null), and a real read failure is a 500, not a 404.
  if (userRes.error) {
    console.error('[admin] user detail read failed:', userRes.error.message)
    return NextResponse.json({ error: 'Could not load this user' }, { status: 500 })
  }
  const user = userRes.data
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  if (membershipsRes.error) console.error('[admin] user memberships read failed:', membershipsRes.error.message)
  let mfaEnrolled: boolean | null = null
  if (factorsRes?.error) console.error('[admin] listFactors failed:', factorsRes.error.message)
  else mfaEnrolled = (factorsRes?.data?.factors || []).some((f: any) => f.factor_type === 'totp')

  await logAdminRead(service, { actor, eventType: 'user.viewed', targetType: 'user', targetId: user.id, targetLabel: user.email })

  return NextResponse.json({
    user,
    memberships: membershipsRes.error ? null : (membershipsRes.data || []),
    mfaEnrolled,
    banned: typeof banned === 'boolean' ? banned : null,
    erased: isAnonymizedEmail(user.email),
    history,
  })
}
