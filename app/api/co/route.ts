import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { sanitizeRichTextOrNull } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
import { computeCoTotals } from '@/lib/documents/co-totals'
import { parseCoFields } from '@/lib/documents/co-input'
import { isTerminalStatus } from '@/lib/utils/project-status'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const body    = await request.json().catch(() => null)
    if (!body || typeof body !== 'object')
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const { projectId, title, note, lineItems, taxRate, taxInclusive, flagId, timelineImpactDays, scopeImpactNote, isRetainerRenewal } = body
    if (!projectId || typeof projectId !== 'string' || title === undefined || title === null || title === '')
      return NextResponse.json({ error: 'projectId and title required' }, { status: 400 })
    const parsedFields = parseCoFields(body)
    if (!parsedFields.ok) return NextResponse.json({ error: parsedFields.error }, { status: 400 })
    if (note !== undefined && note !== null && typeof note !== 'string')
      return NextResponse.json({ error: 'note must be text' }, { status: 400 })
    if (isRetainerRenewal !== undefined && typeof isRetainerRenewal !== 'boolean')
      return NextResponse.json({ error: 'isRetainerRenewal must be true or false' }, { status: 400 })
    if (lineItems !== undefined && !Array.isArray(lineItems))
      return NextResponse.json({ error: 'lineItems must be a list' }, { status: 400 })

    const service = createServiceClient()

    // FIX (audit round 3): projectId was never verified against the
    // caller's workspace before being written into change_orders.project_id
    // — only workspace_id on the new row itself was set to the caller's
    // own workspace. change_orders.project_id has an FK to projects(id)
    // with no cross-check that project.workspace_id matches, so a member
    // of Workspace A could create a CO whose workspace_id is Workspace A
    // but whose project_id points at a project in Workspace B — corrupting
    // that foreign project's CO list and leaking its name/currency into
    // Workspace A via the join on every subsequent read. Also enforces
    // the same per-project visibility rule as everywhere else: a
    // VIEW_OWN_PROJECTS-only holder of CREATE_CHANGE_ORDERS shouldn't be
    // able to create a CO against a project they're not assigned to.
    const { data: project } = await (service as any)
      .from('projects').select('id, status').eq('id', projectId).eq('workspace_id', session.workspaceId)
      .is('deleted_at', null).single()
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // FIX (Projects & Dashboard deep audit, flagship finding — traced from
    // section 7 into CO logic): NOTHING in the CO creation/send/auto-send
    // pipeline ever checked the project's own status — only "does a signed
    // SOW exist" was enforced, which stays true forever once a project
    // completes. A brand-new CO could be drafted and even sent (if under
    // any approval threshold) against a project the agency had already
    // marked Complete or Archived, completely undermining "Complete" as a
    // no-more-scope-changes state. Fail fast at creation; the actual send
    // mechanics (lib/documents/send-co.ts) got the matching guard too, so
    // the auto-send-on-approval path can't bypass this either.
    if (isTerminalStatus(project.status)) {
      return NextResponse.json({
        error: `This project is ${project.status.toLowerCase()} — a change order can no longer be created. Reopen the project first.`,
      }, { status: 409 })
    }

    // FIX (CO-logic fix round — headline finding): nothing here, or in
    // send/route.ts, ever checked that the project actually has a signed
    // SOW. A CO is an amendment to that signed agreement — and
    // lib/documents/finalize-co.ts's acceptance path hard-blocks with
    // "No signed SOW found for this project — cannot record this
    // amendment" if one doesn't exist at accept time. Nothing stopped a CO
    // from being created and sent before that point (project.status can be
    // set to 'Active' directly via PATCH /api/projects/[id] with no
    // signed-SOW check of its own), so a client could review a change
    // order, type their name, draw a signature, and submit — only to hit
    // that 422 after already completing the whole signing ritual, with no
    // path forward except contacting the agency. Block it at the earliest
    // point instead, same pattern as the SOW side's own hard-blocks
    // (governing law, footing) — cheaper for everyone than discovering it
    // at the client's expense.
    const { data: signedSow } = await (service as any)
      .from('sow_documents').select('id')
      .eq('project_id', projectId).eq('status', 'signed')
      .limit(1).maybeSingle()
    if (!signedSow) {
      return NextResponse.json({
        error: 'This project has no signed SOW yet — a change order can only be created once the original scope of work is signed.',
      }, { status: 409 })
    }

    // FIX (re-audit): flagId came straight from the request body with no
    // check that it actually belongs to this project/workspace. Every
    // downstream CO lifecycle action that touches a linked flag — close,
    // withdraw, accept-counter, and the client portal's accept/decline/
    // counter handlers — later fetches and updates guardian_flags by this
    // raw id with no workspace_id filter of its own (they trust the CO's
    // flag_id implicitly). Left unvalidated here, a member could set
    // flagId to a UUID belonging to a DIFFERENT workspace's flag, and a
    // later action on this CO would silently mutate that foreign flag's
    // status — a cross-tenant write via the service-role client, which
    // bypasses RLS entirely. Same rule as roleId in team/invite/route.ts:
    // confirm the referenced row is actually ours before it ever reaches
    // the insert.
    let validatedFlagId: string | null = null
    if (flagId) {
      const { data: flag } = await (service as any)
        .from('guardian_flags').select('id')
        .eq('id', flagId).eq('project_id', projectId).eq('workspace_id', session.workspaceId)
        .maybeSingle()
      if (!flag) return NextResponse.json({ error: 'Flag not found on this project' }, { status: 400 })
      validatedFlagId = flag.id
    }

    // FIX (section-10 audit, 10-B3 + 10-B9): unvalidated arithmetic over
    // raw request JSON, with a tax-inclusive branch that stored the gross
    // as `subtotal`. See lib/documents/co-totals.ts.
    const totals = computeCoTotals(lineItems || [], taxRate ?? 0, taxInclusive)
    if (!totals.ok) return NextResponse.json({ error: totals.error }, { status: 400 })
    const { lineItems: items, subtotal, total } = totals.totals

    const { data: co, error: coErr } = await (service as any)
      .from('change_orders')
      .insert({
        project_id:   projectId,
        workspace_id: session.workspaceId,
        flag_id:      validatedFlagId,
        title:        parsedFields.fields.title!,
        note:         sanitizeRichTextOrNull(note),
        status:       'draft',
        // FIX (section-10 audit): line_items is a jsonb column — writing
        // JSON.stringify(items) stores a JSON-encoded STRING inside it,
        // not a native array, forcing every reader in the codebase to
        // defensively check `typeof === 'string'` before use. accept-
        // counter/route.ts (a later fix) writes the array directly, which
        // is the correct behavior for a jsonb column and proves this
        // stringify call was always the bug, not an intentional
        // convention. Every existing reader already handles a native
        // array (the `else` branch of their typeof check), so this is
        // safe with no reader-side change needed.
        line_items:   items,
        subtotal,
        tax_rate:      totals.totals.taxRate,
        tax_inclusive: totals.totals.taxInclusive,
        total,
        // FIX (section-10 audit, 10-B10): PATCH accepted
        // isRetainerRenewal but POST didn't, so a CO could never be
        // created as one — it could only become one on a later save.
        is_retainer_renewal: isRetainerRenewal === true,
        // FIX (doc-quality audit round 3, migration 018): captured
        // alongside the rest of the CO at creation, same as note/line
        // items — see the PDF renderer's Impact Analysis section for
        // where this surfaces to the client.
        timeline_impact_days: parsedFields.fields.timelineImpactDays ?? null,
        scope_impact_note:    parsedFields.fields.scopeImpactNote ?? null,
        created_by:   session.id,
      })
      .select('id').single()

    if (coErr) throw new Error(coErr.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'co.created', entityType: 'change_order',
      entityId: co.id, entityName: parsedFields.fields.title,
      metadata: { project_id: projectId, total },
    })

    return NextResponse.json({ coId: co.id })
  } catch (err) {
    console.error('CO create error:', err)
    return NextResponse.json({ error: 'Could not create the change order. Please try again.' }, { status: 500 })
  }
}
