export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { sanitizePlainText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'

const MAX_VALUE = 1e12

// FEATURE (independent pass, section 13): an exception (scope given away for free) was
// write-once. A typo in estimated_value or the reason permanently skewed the Reports
// "exceptions granted" total and the contract-value-at-risk rollup, with no way to correct it.
// Corrections are limited to GRANT_EXCEPTIONS holders, only touch the three human-entered
// fields, and record the before/after in the audit log so the history stays reconstructable.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'GRANT_EXCEPTIONS'))
      return NextResponse.json({ error: 'Missing permission: GRANT_EXCEPTIONS' }, { status: 403 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

    const service = createServiceClient()
    const { data: exc } = await (service as any).from('exceptions_log')
      .select('id, project_id, estimated_value, reason, granted_what, projects(name)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()
    if (!exc) return NextResponse.json({ error: 'Exception not found' }, { status: 404 })
    if (!(await canReadProject(service, session, exc.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const updates: Record<string, unknown> = {}
    const changes: Record<string, { from: unknown; to: unknown }> = {}

    if (body?.estimatedValue !== undefined) {
      const v = body.estimatedValue
      const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN)
      if (!Number.isFinite(n) || n < 0 || n > MAX_VALUE)
        return NextResponse.json({ error: 'Estimated value must be a non-negative number' }, { status: 400 })
      const rounded = Math.round(n * 100) / 100
      if (rounded !== Number(exc.estimated_value)) {
        updates.estimated_value = rounded
        changes.estimated_value = { from: Number(exc.estimated_value), to: rounded }
      }
    }
    if (body?.reason !== undefined) {
      const r = typeof body.reason === 'string' ? sanitizePlainText(body.reason.trim()).slice(0, 2000) : ''
      if (!r) return NextResponse.json({ error: 'A reason is required' }, { status: 400 })
      if (r !== exc.reason) { updates.reason = r; changes.reason = { from: exc.reason, to: r } }
    }
    if (body?.grantedWhat !== undefined) {
      const g = typeof body.grantedWhat === 'string' ? sanitizePlainText(body.grantedWhat.trim()).slice(0, 1000) : ''
      if (!g) return NextResponse.json({ error: 'A description of what was granted is required' }, { status: 400 })
      if (g !== exc.granted_what) { updates.granted_what = g; changes.granted_what = { from: exc.granted_what, to: g } }
    }

    if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true, unchanged: true })

    const { error } = await (service as any).from('exceptions_log')
      .update({ ...updates, updated_at: new Date().toISOString(), updated_by: session.id }).eq('id', id)
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'exception.edited', entityType: 'exception', entityId: id,
      entityName: exc.projects?.name || exc.project_id, metadata: { changes },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Exception edit error:', err)
    return NextResponse.json({ error: 'Could not update the exception' }, { status: 500 })
  }
}
