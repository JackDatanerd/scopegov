import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure } from '@/lib/auth/admin'
import { isAuthUserBanned } from '@/lib/utils/account-erasure'

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin()
  if (isAdminGuardFailure(guard)) return guard
  const { service } = guard

  const [{ data: user, error: uErr }, { data: memberships }, { data: factorsData }, banned] = await Promise.all([
    (service as any).from('users').select('id, email, name, is_platform_admin, created_at, deleted_at').eq('id', params.id).maybeSingle(),
    (service as any)
      .from('workspace_members')
      .select('id, status, created_at, workspace_id, workspaces:workspace_id (id, name, agency_name, plan_tier, deleted_at), roles:role_id (name)')
      .eq('user_id', params.id)
      .order('created_at', { ascending: true }),
    (service as any).auth.admin.mfa.listFactors({ userId: params.id }),
    isAuthUserBanned(service, params.id),
  ])

  if (uErr || !user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  const totpFactors = (factorsData?.factors || []).filter((f: any) => f.factor_type === 'totp')

  return NextResponse.json({
    user,
    memberships: memberships || [],
    mfaEnrolled: totpFactors.length > 0,
    banned: banned === true,
  })
}
