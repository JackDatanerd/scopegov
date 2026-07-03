// app/api/workspace/defaults/route.ts

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

// C5: extracted so both POST and PATCH read their own body before calling this,
// avoiding the double-consume bug where PATCH called POST(request) and the
// body stream was already exhausted.
async function upsertDefaults(session: any, body: any) {
  const { revisionRounds, paymentStructure, governingLaw } = body
  const service = createServiceClient()

  const { error } = await (service as any)
    .from('workspace_defaults')
    .upsert({
      workspace_id:      session.workspaceId,
      project_type:      null,
      revision_rounds:   revisionRounds   ?? 2,
      payment_structure: paymentStructure ?? '50_50',
      governing_law:     governingLaw     ?? 'United States', // C15: was 'Republic of Kenya'
      updated_at:        new Date().toISOString(),
    }, { onConflict: 'workspace_id,project_type' })

  if (error) throw new Error(error.message)
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

    const body = await request.json() // read body here before passing — not inside upsertDefaults
    await upsertDefaults(session, body)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
