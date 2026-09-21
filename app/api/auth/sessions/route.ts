export const runtime = 'nodejs'

// GET /api/auth/sessions — the caller's signed-in sessions (this browser marked),
// so a person can see WHERE they are signed in and end one they don't recognise.
// Backed by list_user_sessions() (migration 068), which reads auth.sessions.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { decodeJwtPayload } from '@/lib/auth/auth-time'
import { describeUserAgent } from '@/lib/auth/session-seen'

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: { session } } = await supabase.auth.getSession()
    const currentId = decodeJwtPayload(session?.access_token)?.session_id || null

    const service = createServiceClient() as any
    const { data, error } = await service.rpc('list_user_sessions', { p_user: user.id })
    if (error) {
      console.error('list_user_sessions failed:', error.message)
      return NextResponse.json({ error: 'Could not load your sessions' }, { status: 500 })
    }
    const sessions = ((data || []) as any[]).map(s => ({
      id: s.id as string,
      device: describeUserAgent(s.user_agent).device,
      ip: (s.ip as string | null) || null,
      createdAt: s.created_at as string,
      lastActiveAt: (s.refreshed_at as string | null) || (s.created_at as string),
      mfa: s.aal === 'aal2',
      current: !!currentId && s.id === currentId,
    }))
    return NextResponse.json({ sessions })
  } catch (err) {
    console.error('Sessions GET error:', err)
    return NextResponse.json({ error: 'Could not load your sessions' }, { status: 500 })
  }
}
