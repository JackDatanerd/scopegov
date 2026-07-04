// app/api/team/invite/[token]/signup/route.ts  (NEW FILE)

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token }          = await params
    const { name, password } = await request.json()

    if (!name?.trim() || !password || password.length < 8) {
      return NextResponse.json(
        { error: 'Name and password (8+ chars) required' },
        { status: 400 }
      )
    }

    const service = createServiceClient()

    // Validate the invite token
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id, status, invite_token_expires_at, invited_email, workspace_id')
      .eq('invite_token', token)
      .single()

    if (!member)
      return NextResponse.json({ error: 'Invalid invite token' }, { status: 404 })
    if (member.status !== 'invited')
      return NextResponse.json({ error: 'Invite already used' }, { status: 409 })
    if (new Date(member.invite_token_expires_at) < new Date())
      return NextResponse.json({ error: 'Invite expired' }, { status: 410 })

    const email = member.invited_email
    if (!email)
      return NextResponse.json({ error: 'No email on invite' }, { status: 400 })

    // Use Admin API to create user with auto-confirmed email.
    // Invited users are pre-verified — the invite was sent to this address.
    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: name.trim() },
    })

    if (createErr) {
      if (createErr.message.includes('already been registered')) {
        return NextResponse.json(
          { error: 'An account with this email already exists. Use the sign-in tab.' },
          { status: 409 }
        )
      }
      throw new Error(createErr.message)
    }

    const userId = newUser.user.id
    const now    = new Date().toISOString()

    // Create public.users row (trigger may not fire reliably via admin API)
    await (service as any).from('users').upsert({
      id:                  userId,
      email,
      name:                name.trim(),
      email_verified_at:   now,
      active_workspace_id: member.workspace_id,
    }, { onConflict: 'id' })

    // Get default role for workspace
    const { data: defaultRole } = await (service as any)
      .from('roles')
      .select('id, permissions')
      .eq('workspace_id', member.workspace_id)
      .eq('is_default', true)
      .single()

    // Activate workspace membership
    await (service as any)
      .from('workspace_members')
      .update({
        user_id:               userId,
        status:                'active',
        joined_at:             now,
        invite_token:          null,
        effective_permissions: defaultRole?.permissions || '{}',
        role_id:               defaultRole?.id || null,
      })
      .eq('id', member.id)

    return NextResponse.json({ ok: true, email })
  } catch (err) {
    console.error('Invite signup error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Error' },
      { status: 500 }
    )
  }
}
