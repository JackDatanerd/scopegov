import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }          = await params
    const { name, password } = await request.json()

    if (!name?.trim())         return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    if (!password || password.length < 8)
      return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 })

    const service = createServiceClient()

    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id, status, invite_token_expires_at, invited_email, workspace_id, role_id')
      .eq('invite_token', token)
      .single()

    if (!member) {
      return NextResponse.json({
        error: 'This invite link has already been used. Try signing in directly.',
        alreadyUsed: true,
      }, { status: 409 })
    }

    if (member.status === 'active') {
      return NextResponse.json({
        error: 'You are already a member. Sign in to continue.',
        alreadyMember: true,
        email: member.invited_email,
      }, { status: 409 })
    }

    if (new Date(member.invite_token_expires_at) < new Date())
      return NextResponse.json({ error: 'This invite has expired. Ask the workspace owner to resend it.' }, { status: 410 })

    const email = member.invited_email
    if (!email) return NextResponse.json({ error: 'Invite email missing.' }, { status: 400 })

    const adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    let userId: string
    const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: name.trim() },
    })

    if (createErr) {
      if (createErr.message.toLowerCase().includes('already') || createErr.message.toLowerCase().includes('exists')) {
        return NextResponse.json({
          error: 'An account with this email already exists. Sign in to accept the invite.',
          existingAccount: true,
          email,
        }, { status: 409 })
      }
      throw new Error(createErr.message)
    }

    userId = newUser.user.id
    const now = new Date().toISOString()

    await (service as any).from('users').upsert({
      id: userId, email, name: name.trim(),
      email_verified_at: now,
      active_workspace_id: member.workspace_id,
    }, { onConflict: 'id' })

    const { data: defaultRole } = await (service as any)
      .from('roles').select('id, permissions')
      .eq('workspace_id', member.workspace_id).eq('is_default', true).single()

    // BUG FIX (Fix 3): previously set invite_token: null here. That made the
    // row unreachable by `.eq('invite_token', token)` the moment signup
    // succeeded, so re-visiting the same link produced a 404/500 from the
    // GET validate route instead of the intended "already accepted" message
    // (which relies on finding the row and checking status === 'active').
    // Reuse is already prevented by the status check above — the token can
    // stay on the row indefinitely.
    const { error: activateErr } = await (service as any)
      .from('workspace_members')
      .update({
        user_id: userId, status: 'active', joined_at: now,
        effective_permissions: defaultRole?.permissions || '{}',
        role_id: member.role_id || defaultRole?.id || null,
      })
      .eq('id', member.id)

    if (activateErr) throw new Error(`Membership activation failed: ${activateErr.message}`)

    return NextResponse.json({ ok: true, email })
  } catch (err) {
    console.error('Invite signup error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
