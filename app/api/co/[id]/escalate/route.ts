import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sendEscalationEmail } from '@/lib/email/templates'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { escalateTo, escalationNote } = await request.json()
    if (!escalationNote || escalationNote.trim().length < 10)
      return NextResponse.json({ error: 'Escalation note must be at least 10 characters' }, { status: 400 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select('id,title,status,project_id,projects(name)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'CO not found' }, { status: 404 })

    const now = new Date().toISOString()

    // Spec §6.3: escalation NEVER changes status — it is an overlay
    await (service as any).from('change_orders').update({
      escalated_to:    escalateTo || session.id,
      escalation_note: escalationNote.trim(),
      updated_at:      now,
    }).eq('id', id)

    // Event 24: escalation notification
    if (escalateTo) {
      const { data: assignee } = await (service as any)
        .from('users').select('name,email').eq('id', escalateTo).single()
      if (assignee?.email) {
        try {
          await sendEscalationEmail({
            to:          assignee.email,
            assigneeName: assignee.name,
            agencyName:  session.agencyName,
            entityType:  'change order',
            entityName:  co.projects?.name || '',
            note:        escalationNote.trim(),
            url:         `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
          })
        } catch (e) { console.error('Escalation email failed:', e) }
      }
    }

    // co.escalated is an AUDIT EVENT TYPE — records the action
    // It is NOT a status value (BUG-049)
    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.escalated', entityType: 'change_order',
      entityId: id, entityName: co.title,
      metadata: { escalated_to: escalateTo, note: escalationNote, co_status: co.status },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
