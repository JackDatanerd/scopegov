export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { recordApprovalDecision } from '@/lib/approvals/engine'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let note: string | undefined
    try { const body = await request.json(); note = typeof body?.note === 'string' ? body.note : undefined } catch { /* body optional */ }

    const service = createServiceClient()
    const result = await recordApprovalDecision(service, {
      requestId: id, actor: session, decision: 'approved', note,
    })

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
