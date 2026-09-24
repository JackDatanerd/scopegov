import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { canReadProject } from '@/lib/utils/project-access'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'EDIT_SOW'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const { projectId, deliverable, oldValue, newValue, reason, field: rawField } = await request.json()
    if (!projectId || !deliverable || !newValue || !reason?.trim())
      return NextResponse.json({ error: 'deliverable, newValue, and reason are required' }, { status: 400 })

    // FEATURE (deep audit, section 13 — feature gap): this route only ever
    // matched against project_scope_snapshot.deliverables — an out_of_scope
    // ("Excluded") entry had no correction path at all, in the UI or here,
    // even though it's the same snapshot row and just as prone to a typo as
    // a deliverable. `field` is optional and defaults to 'deliverables' so
    // every existing caller (ScopeAdjustModal's deliverable flow) keeps
    // working unchanged.
    const field: 'deliverables' | 'out_of_scope' = rawField === 'out_of_scope' ? 'out_of_scope' : 'deliverables'
    const fieldLabel = field === 'out_of_scope' ? 'excluded item' : 'deliverable'

    const service = createServiceClient()

    // Verify project
    const { data: project } = await (service as any)
      .from('projects').select('id,name').eq('id', projectId)
      .eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const now = new Date().toISOString()

    // FIX (audit round 6): this route's own prior comment admitted the
    // spec's "synchronous row-locked snapshot write... all in one
    // transaction" wasn't actually built — it was a plain read-modify-write
    // with no lock and no transaction ("best-effort sequential here"). Two
    // concurrent adjustments to the same project could silently clobber
    // each other's change to `deliverables`. It also matched the target
    // deliverable by title with `.map()` and, if nothing matched (stale
    // client state, a rename, a typo), silently produced an *unchanged*
    // array while still recording a scope_adjustments row and an audit
    // entry claiming the change happened — the audit trail and the actual
    // scope-of-record could diverge with no error to anyone.
    //
    // Fixed by reordering (validate + write the snapshot BEFORE recording
    // history, so the two can never disagree) and by using an optimistic-
    // concurrency version column (project_scope_snapshot.version) in place
    // of a real row lock, since supabase-js can't take one or wrap this in
    // a transaction.
    const { data: snap } = await (service as any)
      .from('project_scope_snapshot').select('id,deliverables,out_of_scope,version').eq('project_id', projectId).single()

    // FIX (deep audit, section 13): this route's own comment above claims
    // the "record a change that didn't really land" class of bug was
    // fixed by reordering the write-before-history — but that reordering
    // only covered the "deliverable not found in an existing snapshot"
    // case below. Calling this route for a project with NO snapshot row
    // at all (no signed SOW yet) skipped the entire `if (snap)` block —
    // nothing to update — and fell straight through to recording a
    // scope_adjustments row and an audit entry claiming the deliverable
    // was changed, with no scope-of-record anywhere for that to have
    // actually happened to. The UI never triggers this (the adjust button
    // only renders for deliverables pulled from an existing snapshot), but
    // the route is directly callable and has no business accepting an
    // adjustment against scope that doesn't exist yet.
    if (!snap) {
      return NextResponse.json({
        error: 'This project has no scope snapshot yet — a scope adjustment can only be made once a SOW has been signed.',
      }, { status: 409 })
    }

    let matched = false
    const sourceList = field === 'out_of_scope' ? (snap.out_of_scope || []) : (snap.deliverables || [])
    const updatedList = sourceList.map((d: any) => {
      // FIX (deep audit, section 13): only rename the FIRST match. Two
      // entries sharing the same title (a duplicate entry, however it
      // got there) would previously all get silently renamed to the same
      // newValue in one call — `matched` was tracked as a single boolean,
      // but nothing stopped the `.map()` from touching every match it saw.
      if (matched) return d
      if (d && typeof d === 'object' && d.title === deliverable) {
        matched = true
        return { ...d, title: newValue } // preserve any other fields on the entry, not just title
      }
      if (d === deliverable) { matched = true; return { title: newValue } }
      return d
    })

    if (!matched) {
      return NextResponse.json({
        error: `That ${fieldLabel} ("${deliverable}") was not found in the current scope snapshot — it may have changed since this page loaded. Refresh and try again.`,
      }, { status: 409 })
    }

    const { data: updatedSnap, error: snapErr } = await (service as any)
      .from('project_scope_snapshot')
      .update({
        [field]: updatedList,
        last_updated_at: now,
        last_updated_by: 'scope_adjustment',
        version: (snap.version || 1) + 1,
      })
      .eq('project_id', projectId)
      .eq('version', snap.version) // compare-and-swap — fails (0 rows) if someone else updated it first
      .select('id')

    if (snapErr) throw new Error(snapErr.message)
    if (!updatedSnap || updatedSnap.length === 0) {
      return NextResponse.json({
        error: 'The scope snapshot changed while processing this adjustment — please retry.',
      }, { status: 409 })
    }

    // Only recorded once the snapshot write (if any) has actually
    // succeeded, so this history entry can never describe a change that
    // didn't really land.
    const { data: adjustment, error: adjErr } = await (service as any)
      .from('scope_adjustments').insert({
        project_id:   projectId,
        workspace_id: session.workspaceId,
        deliverable,
        field,
        old_value:    oldValue || '',
        new_value:    newValue,
        reason:       reason.trim(),
        adjusted_by:  session.id,
      }).select('id').single()

    if (adjErr) throw new Error(adjErr.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'project.scope_adjustment_made', entityType: 'project',
      entityId: projectId, entityName: project.name,
      metadata: { deliverable, field, old_value: oldValue, new_value: newValue, reason },
    })

    return NextResponse.json({ ok: true, adjustmentId: adjustment.id })
  } catch (err) {
    console.error('guardian/scope-adjustment error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
