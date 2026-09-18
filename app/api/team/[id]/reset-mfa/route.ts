import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { permissionsBeyondActorForTarget } from '@/lib/utils/permission-ceiling'
import { logAudit } from '@/lib/utils/audit'
import { sendMfaDisabledEmail } from '@/lib/email/templates'

// FEATURE (deep audit, Auth+MFA section — feature gap): there was no way
// back into the app for a member who lost their authenticator device AND
// had used or lost every backup code — a real possibility for anyone MFA
// mandates cover (lib/auth/mfa-policy.ts's MFA_REQUIRED_PERMISSIONS), up
// to and including the sole workspace owner. The self-service recovery
// path (api/auth/mfa/recover/route.ts) needs a still-valid backup code;
// once those are gone, nothing in the app — no route, no admin action —
// could clear another member's MFA factor. Only someone with direct
// Supabase-dashboard/DB access outside the product entirely could unstick
// them. This mirrors mfa/recover's own approach (delete the TOTP
// factor(s) via the admin API, forcing aal1 + re-enrollment on next
// mandated request) but reachable by a MANAGE_ROLES holder acting on a
// locked-out peer, instead of requiring the locked-out person's own
// backup code. Same floor check as every other Team action that targets
// a specific member: you can't act on someone who effectively holds
// permissions you don't hold yourself.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_ROLES'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_ROLES' }, { status: 403 })

    const service = createServiceClient()

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id,user_id,status,effective_permissions,users!workspace_members_user_id_fkey(name,email)')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()

    if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
    if (!member.user_id)
      return NextResponse.json({ error: 'This invite has not been accepted yet' }, { status: 400 })
    if (member.user_id === session.id)
      return NextResponse.json({ error: 'Use Settings to manage your own two-factor authentication' }, { status: 400 })
    if (member.status !== 'active')
      return NextResponse.json({ error: 'This member is not active' }, { status: 400 })

    // Same floor check as DELETE and PATCH on this same member surface —
    // see app/api/team/[id]/route.ts.
    const outOfReach = permissionsBeyondActorForTarget(session, member.effective_permissions)
    if (outOfReach.length > 0)
      return NextResponse.json({
        error: `Cannot reset MFA for a member who holds permissions you don't hold yourself: ${outOfReach.join(', ')}`,
      }, { status: 403 })

    const { data: factorsData, error: listErr } = await (service as any).auth.admin.mfa.listFactors({ userId: member.user_id })
    if (listErr) throw new Error(listErr.message)

    const totpFactors = (factorsData?.factors || []).filter((f: any) => f.factor_type === 'totp')
    if (totpFactors.length === 0)
      return NextResponse.json({ error: 'This member has no two-factor authentication enrolled.' }, { status: 400 })

    for (const f of totpFactors) {
      const { error: delErr } = await (service as any).auth.admin.mfa.deleteFactor({ id: f.id, userId: member.user_id })
      if (delErr) throw new Error(delErr.message)
    }

    // Any unused backup codes belonged to the enrollment that's now gone —
    // mark them spent so a stale code can't outlive the factor it was
    // meant to recover. Same cleanup api/auth/mfa/recover/route.ts does.
    await (service as any).from('user_mfa_backup_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', member.user_id).is('used_at', null)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'security.mfa_reset_by_admin', entityType: 'user',
      entityId: member.user_id, entityName: member.users?.name || member.users?.email || '',
      metadata: {},
    })

    const targetEmail = member.users?.email
    if (targetEmail) {
      sendMfaDisabledEmail({ to: targetEmail, name: member.users?.name || targetEmail, via: 'admin_reset' })
        .catch((e: unknown) => console.error('Admin MFA reset email failed (non-fatal):', e))
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Team member reset-mfa error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
