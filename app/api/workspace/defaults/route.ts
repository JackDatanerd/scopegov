// app/api/workspace/defaults/route.ts

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

// C5: PostgreSQL unique constraints treat NULL != NULL, so upsert with
// onConflict on project_type (which is null here) silently inserts duplicates
// instead of updating. Fix: explicit check-then-update-or-insert.
async function upsertDefaults(session: any, body: any) {
  const { revisionRounds, paymentStructure, governingLaw } = body
  const service = createServiceClient()

  const { data: existing } = await (service as any)
    .from('workspace_defaults')
    .select('id')
    .eq('workspace_id', session.workspaceId)
    .is('project_type', null)
    .maybeSingle()

  const payload = {
    workspace_id:      session.workspaceId,
    project_type:      null,
    revision_rounds:   revisionRounds   ?? 2,
    payment_structure: paymentStructure ?? '50_50',
    governing_law:     governingLaw     ?? 'United States',
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
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body = await request.json()
    await upsertDefaults(session, body)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body = await request.json()
    await upsertDefaults(session, body)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
