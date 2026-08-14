import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { nanoid } from 'nanoid'
import crypto from 'crypto'

function generateSlug(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40) + '-' + nanoid(6)
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { agencyName, industry, currency, timezone } = await request.json()
    if (!agencyName || !industry) {
      return NextResponse.json({ error: 'Agency name and industry are required' }, { status: 400 })
    }

    // Use service client for workspace creation (bypasses RLS — BUG-002)
    const service = createServiceClient()

    const jwtSecret = crypto.randomBytes(32).toString('hex')
    const workspaceId = crypto.randomUUID()
    const slug = generateSlug(agencyName)

    // ── Atomic workspace creation (spec §1.0) ─────────────────────────────
    // workspace INSERT + workspace_members INSERT must succeed together or not at all
    // Supabase JS doesn't have multi-statement transactions, so we use RPC

    const { error: rpcError } = await (service as any).rpc('create_workspace_atomic', {
      p_workspace_id: workspaceId,
      p_user_id: user.id,
      p_name: agencyName,
      p_slug: slug,
      p_agency_name: agencyName,
      p_industry: industry,
      p_currency: currency || 'USD',
      p_timezone: timezone || 'Africa/Nairobi',
      p_jwt_secret: jwtSecret,
    })

    if (rpcError) {
      // FIX (re-audit, minor finding): raw Postgres error message/code/hint
      // was returned straight to the browser — fine for local debugging,
      // but an information-disclosure leftover for production. Log server-side
      // only now.
      console.error('create_workspace_atomic failed:', JSON.stringify(rpcError))
      return NextResponse.json({
        error: 'Failed to create workspace',
      }, { status: 500 })
    }

    // Update user's active workspace
    await (service as any)
      .from('users')
      .upsert({ id: user.id, email: user.email, name: user.user_metadata?.name || '', active_workspace_id: workspaceId })

    // Audit log
    await (service as any).from('audit_log').insert({
      workspace_id: workspaceId,
      actor_id: user.id,
      actor_email: user.email,
      actor_name: user.user_metadata?.name || user.email,
      event_type: 'workspace.created',
      entity_type: 'workspace',
      entity_id: workspaceId,
      entity_name: agencyName,
      metadata: { plan: 'trial' },
    })

    return NextResponse.json({ workspaceId, slug })
  } catch (err) {
    console.error('Workspace create error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
