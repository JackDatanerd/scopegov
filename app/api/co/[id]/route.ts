import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sanitizeRichTextOrNull } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'
import { computeCoTotals } from '@/lib/documents/co-totals'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      // FIX (regression, introduced same session as the flag-context AI
      // draft feature): guardian_flags <-> guardian_checks has TWO FKs —
      // guardian_flags.check_id -> guardian_checks.id (fk_flag_check) and
      // guardian_checks.flag_id -> guardian_flags.id. An unhinted nested
      // embed here is ambiguous to PostgREST ("more than one relationship
      // was found"), so the whole query silently failed — `co` came back
      // null, this route 404'd, and CoEditor's fetch (which never checked
      // res.ok — also fixed, see components/co/CoEditor.tsx) rendered
      // that as a blank untouched form with no visible error. Every CO
      // fetch by id was broken by this, not just flag-linked ones.
      // `!fk_flag_check` disambiguates to the correct direction, same
      // hint pattern already used elsewhere in this codebase (see
      // lib/utils/permissions-query.ts, app/api/team/[id]/route.ts).
      .select('*, projects(id,name,currency), guardian_flags(description,severity,sow_reference,guardian_checks!fk_flag_check(content))')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // FIX (audit round 3): workspace_id was the only scoping check — any
    // workspace member, regardless of project assignment, could fetch any
    // CO's full financial detail. See lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const flagRequestText: string | null = co.guardian_flags?.guardian_checks?.content ?? null
    // FIX (section-10 audit): `select('*')` above pulls every column,
    // including `token` — the raw client-portal JWT used for accept/
    // counter/decline/countersign — and this route returned it
    // unconditionally to any project-assigned viewer regardless of
    // SEND_CHANGE_ORDERS. No frontend consumer (CoEditor.tsx,
    // ProjectDetail.tsx) ever reads co.token from this response, so it
    // was pure over-exposure: a low-permission viewer could lift it and
    // act as the client directly against /api/portal/co/[token]/*.
    // Stripped the same way guardian_flags already is.
    const { guardian_flags, token, ...coRest } = co
    return NextResponse.json({ co: { ...coRest, currency: co.projects?.currency, flagRequestText } })
  } catch {
    return NextResponse.json({ error: 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_CHANGE_ORDERS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders').select('id,status,project_id').eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (co.status !== 'draft')
      return NextResponse.json({ error: 'Only draft COs can be edited' }, { status: 409 })

    // FIX (re-audit, critical finding): same gate-bypass gap fixed in
    // api/sow/[id]/route.ts — a CO gated by an approval workflow never
    // leaves status:'draft' until the chain clears, so this route's only
    // lock condition (status !== 'draft') never applied to a gated draft.
    // Nothing stopped the document being edited out from under the
    // snapshot the approvers were actually reviewing.
    if (await getPendingApprovalForDocument(service, 'co', id)) {
      return NextResponse.json(
        { error: 'This change order has a pending approval request — cancel it before editing.' },
        { status: 409 }
      )
    }

    const body = await request.json()
    const { title, note, lineItems, taxRate, taxInclusive, isRetainerRenewal, timelineImpactDays, scopeImpactNote } = body

    // FIX (CO-logic fix round): POST /api/co requires a non-empty title;
    // this route never did — `title?.trim()` happily wrote an empty string
    // over an existing one. CoEditor's Save/Send buttons are disabled while
    // `!title.trim()`, so this was unreachable through the normal UI, but
    // a direct call could blank out a CO's title with no error, same class
    // of gap as everywhere else in this codebase that validates
    // server-side even though the client already does.
    if (!title || !title.trim())
      return NextResponse.json({ error: 'Title required' }, { status: 400 })

    // FIX (section-10 audit, 10-B3 + 10-B9): same unvalidated arithmetic
    // and same wrong tax-inclusive subtotal as POST /api/co — both now go
    // through the one shared implementation. See lib/documents/co-totals.ts.
    const totals = computeCoTotals(lineItems || [], taxRate ?? 0, taxInclusive)
    if (!totals.ok) return NextResponse.json({ error: totals.error }, { status: 400 })
    const { lineItems: items, subtotal, total } = totals.totals

    await (service as any).from('change_orders').update({
      title:               title.trim(),
      note:                sanitizeRichTextOrNull(note),
      // FIX (section-10 audit): see app/api/co/route.ts for the full
      // explanation — line_items is jsonb; storing JSON.stringify(items)
      // wrote a string, not a native array. accept-counter/route.ts
      // already writes the array directly; matched that here.
      line_items:          items,
      subtotal,
      tax_rate:            totals.totals.taxRate,
      tax_inclusive:       totals.totals.taxInclusive,
      total,
      is_retainer_renewal: isRetainerRenewal || false,
      timeline_impact_days: timelineImpactDays != null && timelineImpactDays !== '' ? parseInt(timelineImpactDays, 10) : null,
      scope_impact_note:    scopeImpactNote?.trim() || null,
      updated_at:          new Date().toISOString(),
    }).eq('id', id)

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
