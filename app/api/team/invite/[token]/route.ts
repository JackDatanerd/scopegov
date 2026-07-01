import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

// GET /api/team/invite/[token] — validate token, return invite details
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service   = createServiceClient()

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select(`
        id, status, invite_token_expires_at, invited_email, user_id,
        workspace_id,
        workspaces (id, name, agency_name),
        invited_by_user:users!workspace_members_invited_by_fkey (name)
      `)
      .eq('invite_token', token)
      .single()

    if (!member) return NextResponse.json({ error: 'Invalid invite token' }, { status: 404 })

    if (member.status === 'active')
      return NextResponse.json({ error: 'Invite already accepted', expired: true })

    if (member.status === 'deactivated')
      return NextResponse.json({ error: 'Invite no longer valid', expired: true })

    const expires = new Date(member.invite_token_expires_at)
    if (expires < new Date())
      return NextResponse.json({ error: 'Invite expired', expired: true })

    // BUG-FIX: previously read a non-existent `member.user_email` field,
    // which was always undefined. The invited email is stored on
    // `invited_email` for pending invites (set at invite-creation time).
    let inviteEmail = member.invited_email || ''

    // If somehow user_id is set but invited_email wasn't (e.g. legacy rows),
    // fall back to looking up the user's email directly.
    if (!inviteEmail && member.user_id) {
      const { data: u } = await (service as any)
        .from('users').select('email').eq('id', member.user_id).single()
      inviteEmail = u?.email || ''
    }

    const hasAccount = !!member.user_id

    return NextResponse.json({
      invite: {
        email:         inviteEmail,
        workspaceName: member.workspaces?.name,
        agencyName:    member.workspaces?.agency_name,
        inviterName:   member.invited_by_user?.name || 'Your team',
      },
      hasAccount,
      memberId: member.id,
    })
  } catch (err) {
    console.error('Invite validation error:', err)
    return NextResponse.json({ error: 'Error validating invite' }, { status: 500 })
  }
}
