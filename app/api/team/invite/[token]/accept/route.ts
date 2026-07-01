import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }  = await params
    const supabase   = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id,status,workspace_id,invite_token_expires_at,invited_email,role_id,workspaces(name)')
      .eq('invite_token', token)
      .single()

    if (!member) return NextResponse.json({ error: 'Invalid invite token' }, { status: 404 })
    if (member.status === 'active')
      return NextResponse.json({ error: 'Invite already accepted' }, { status: 409 })

    const expires = new Date(member.invite_token_expires_at)
    if (expires < new Date())
      return NextResponse.json({ error: 'Invite expired' }, { status: 410 })

    // Verify the accepting account matches the invited address — prevents
    // a leaked token being accepted by an unrelated account.
    if (member.invited_email && user.email?.toLowerCase() !== member.invited_email.toLowerCase()) {
      return NextResponse.json({
        error: `This invite was sent to ${member.invited_email}. Please sign in with that email address.`,
      }, { status: 403 })
    }

    const now = new Date().toISOString()

    // Get default role for this workspace
    const { data: defaultRole } = await (service as any)
      .from('roles')
      .select('id,permissions')
      .eq('workspace_id', member.workspace_id)
      .eq('is_default', true)
      .single()

    // Activate membership
    await (service as any).from('workspace_members').update({
      user_id:              user.id,
      status:               'active',
      joined_at:            now,
      invite_token:         null,
      role_id:              member.role_id || defaultRole?.id || null,
      effective_permissions: defaultRole?.permissions || '{}',
    }).eq('id', member.id)

    // Ensure user row exists (BUG-002: INSERT policy + service role)
    await (service as any).from('users').upsert({
      id:                   user.id,
      email:                user.email,
      name:                 user.user_metadata?.name || '',
      active_workspace_id:  member.workspace_id,
      email_verified_at:    user.email_confirmed_at || now, // invited = pre-verified (spec §16.0)
    }, { onConflict: 'id' })

    await logAudit(service, {
      workspaceId: member.workspace_id,
      actorId: user.id, actorEmail: user.email!, actorName: user.user_metadata?.name || user.email!,
      eventType: 'member.joined', entityType: 'workspace_member',
      entityId: member.id, entityName: user.email!,
      metadata: { workspace_name: member.workspaces?.name },
    })

    return NextResponse.json({ ok: true, workspaceId: member.workspace_id })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
