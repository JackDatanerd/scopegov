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

    let note = ''
    try { const body = await request.json(); note = typeof body?.note === 'string' ? body.note.trim() : '' } catch { /* fallthrough to validation */ }

    // Unlike approval (where a note is a nice-to-have), a rejection needs a
    // reason — the whole value of a governance audit trail is knowing WHY
    // a CO or SOW got sent back, not just that it did.
    if (!note)
      return NextResponse.json({ error: 'Please explain why this is being rejected' }, { status: 400 })

    const service = createServiceClient()
    const result = await recordApprovalDecision(service, {
      requestId: id, actor: session, decision: 'rejected', note,
    })

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json(result)
  } catch (err) {
    console.error('Approval decision (reject) error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
