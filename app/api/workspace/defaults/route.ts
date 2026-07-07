// app/api/workspace/defaults/route.ts
// Fix 2 final: abandoned onConflict entirely. PostgREST partial unique index
// support is unreliable across Supabase versions. Explicit check-then-update
// works regardless of what constraints exist in the database.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'

async function saveDefaults(workspaceId: string, body: any) {
  const { revisionRounds, paymentStructure, governingLaw } = body
  const service = createServiceClient()

  // Check if a global default row already exists for this workspace
  const { data: existing } = await (service as any)
    .from('workspace_defaults')
    .select('id')
    .eq('workspace_id', workspaceId)
    .is('project_type', null)
    .maybeSingle()

  const payload = {
    workspace_id:      workspaceId,
    project_type:      null,
    revision_rounds:   Number(revisionRounds) || 2,
    payment_structure: paymentStructure || '50_50',
    governing_law:     governingLaw || 'United States',
    updated_at:        new Date().toISOString(),
  }

  if (existing?.id) {
    const { error } = await (service as any)
      .from('workspace_defaults')
      .update(payload)
      .eq('id', existing.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await (service as any)
      .from('workspace_defaults')
      .insert(payload)
    if (error) throw new Error(error.message)
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = await request.json()
    await saveDefaults(session.workspaceId, body)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = await request.json()
    await saveDefaults(session.workspaceId, body)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
