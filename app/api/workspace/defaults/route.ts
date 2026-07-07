// app/api/workspace/defaults/route.ts
// FIX 2: onConflict now uses 'workspace_id' (the partial unique index column),
// not 'workspace_id,project_type' which failed on NULL values.
// Run the SQL from the fix doc FIRST to clean up duplicate rows and create the index.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'

async function saveDefaults(workspaceId: string, body: any) {
  const { revisionRounds, paymentStructure, governingLaw } = body
  const service = createServiceClient()

  // onConflict: 'workspace_id' works because the partial unique index
  // (workspace_id) WHERE project_type IS NULL enforces uniqueness for the
  // global default row. PostgREST maps this correctly after the index is created.
  const { error } = await (service as any)
    .from('workspace_defaults')
    .upsert({
      workspace_id:      workspaceId,
      project_type:      null,
      revision_rounds:   Number(revisionRounds) || 2,
      payment_structure: paymentStructure || '50_50',
      governing_law:     governingLaw || 'United States',
      updated_at:        new Date().toISOString(),
    }, {
      onConflict:       'workspace_id',
      ignoreDuplicates: false,
    })

  if (error) throw new Error(error.message)
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
    const body = await request.json() // read body here — never re-reads
    await saveDefaults(session.workspaceId, body)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
