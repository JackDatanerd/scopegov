import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'

async function saveDefaults(session: any, body: any) {
  const { revisionRounds, paymentStructure, governingLaw } = body
  const service = createServiceClient()

  // Cannot use onConflict with NULL columns — PostgreSQL NULL != NULL in UNIQUE.
  // Instead: update if exists, insert if not.
  const { data: existing } = await (service as any)
    .from('workspace_defaults')
    .select('id')
    .eq('workspace_id', session.workspaceId)
    .is('project_type', null)
    .maybeSingle()

  if (existing?.id) {
    const { error } = await (service as any)
      .from('workspace_defaults')
      .update({
        revision_rounds:   revisionRounds ?? 2,
        payment_structure: paymentStructure ?? '50_50',
        governing_law:     governingLaw ?? 'United States',
        updated_at:        new Date().toISOString(),
      })
      .eq('id', existing.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await (service as any)
      .from('workspace_defaults')
      .insert({
        workspace_id:      session.workspaceId,
        project_type:      null,
        revision_rounds:   revisionRounds ?? 2,
        payment_structure: paymentStructure ?? '50_50',
        governing_law:     governingLaw ?? 'United States',
      })
    if (error) throw new Error(error.message)
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = await request.json()
    await saveDefaults(session, body)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = await request.json()   // read body once here, never again
    await saveDefaults(session, body)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
