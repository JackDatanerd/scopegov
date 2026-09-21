import { createServiceClient } from '@/lib/supabase/server'
import { parseRenewalTerm } from '@/lib/documents/renewal-term'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sanitizeRichTextOrNull } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'
import { getPendingApprovalForDocument } from '@/lib/approvals/engine'
import { computeCoTotals } from '@/lib/documents/co-totals'
import { parseCoFields } from '@/lib/documents/co-input'

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
    // token is a credential; the client's signature image and IP are evidence, not editor data — they
    // were shipped (up to ~500 KB of base64) to every member who could open the draft.
    const { guardian_flags, token, client_signature_data, signer_ip, ...coRest } = co
    const pendingApproval = co.status === 'draft' ? !!(await getPendingApprovalForDocument(service, 'co', id)) : false

    // FIX (section-10 audit): this returned line_items/subtotal/tax_rate/
    // tax_inclusive/total/counter_amount/counter_note to ANY project-
    // assigned viewer with no VIEW_FINANCIALS check at all — the same data
    // ProjectDetail.tsx's own CoCard deliberately hides behind
    // `permissions.viewFinancials` ({permissions.viewFinancials &&
    // <span>{formatCurrency(co.total, ...)}</span>}), and the same
    // permission GET /api/sow/[id] already gates contractValue on. A
    // member explicitly denied financial visibility (the preset Designer
    // role, VIEW_FINANCIALS: false) could open a CO's edit URL directly
    // and read every rate and total the UI was hiding from them elsewhere.
    // Redact rather than 403 the whole route — same softer pattern as the
    // SOW side — so non-financial fields (title, note, status, scope/
    // timeline impact) stay visible to any project member who can already
    // see this CO exists. `permissions` lets CoEditor render a real
    // "hidden" state instead of a blank/zeroed-out editable form.
    const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')
    const FINANCIAL_FIELDS = ['line_items', 'subtotal', 'tax_rate', 'tax_inclusive', 'total', 'counter_amount', 'counter_note'] as const
    const safeCoRest: Record<string, unknown> = { ...coRest }
    if (!canViewFinancials) {
      for (const field of FINANCIAL_FIELDS) safeCoRest[field] = null
    }

    return NextResponse.json({
      co: { ...safeCoRest, currency: co.projects?.currency, flagRequestText },
      pendingApproval,
      permissions: {
        canEdit: hasPermission(session, 'CREATE_CHANGE_ORDERS'),
        canViewFinancials,
      },
    })
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
      .from('change_orders')
      .select('id,status,project_id,line_items,tax_rate,tax_inclusive')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (co.status !== 'draft')
      return NextResponse.json({ error: 'Only draft COs can be edited' }, { status: 409 })

    if (await getPendingApprovalForDocument(service, 'co', id)) {
      return NextResponse.json(
        { error: 'This change order has a pending approval request — cancel it before editing.' },
        { status: 409 }
      )
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object')
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const { note, lineItems, taxRate, taxInclusive, isRetainerRenewal, renewalTermMonths } = body

    const parsedFields = parseCoFields(body)
    if (!parsedFields.ok) return NextResponse.json({ error: parsedFields.error }, { status: 400 })
    if (note !== undefined && note !== null && typeof note !== 'string')
      return NextResponse.json({ error: 'note must be text' }, { status: 400 })
    if (isRetainerRenewal !== undefined && typeof isRetainerRenewal !== 'boolean')
      return NextResponse.json({ error: 'isRetainerRenewal must be true or false' }, { status: 400 })
    const renewalTerm = parseRenewalTerm(renewalTermMonths)
    if (!renewalTerm.ok) return NextResponse.json({ error: renewalTerm.error }, { status: 400 })
    if (lineItems !== undefined && !Array.isArray(lineItems))
      return NextResponse.json({ error: 'lineItems must be a list' }, { status: 400 })

    // Partial update: only fields that are present change. This route used to behave like PUT —
    // a body that left out `note`, `lineItems` or `isRetainerRenewal` silently blanked them
    // (an omitted list saved as an EMPTY list, an omitted flag un-marked a retainer renewal).
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (parsedFields.fields.title !== undefined)              update.title = parsedFields.fields.title
    if (parsedFields.fields.scopeImpactNote !== undefined)    update.scope_impact_note = parsedFields.fields.scopeImpactNote
    if (parsedFields.fields.timelineImpactDays !== undefined) update.timeline_impact_days = parsedFields.fields.timelineImpactDays
    if (note !== undefined)               update.note = sanitizeRichTextOrNull(note)
    if (isRetainerRenewal !== undefined)  update.is_retainer_renewal = isRetainerRenewal
    // The term only means something on a renewal: un-ticking the box clears it.
    if (isRetainerRenewal === false)      update.renewal_term_months = null
    else if (renewalTermMonths !== undefined) update.renewal_term_months = renewalTerm.value

    if (lineItems !== undefined || taxRate !== undefined || taxInclusive !== undefined) {
      const totals = computeCoTotals(
        lineItems ?? co.line_items ?? [],
        taxRate ?? co.tax_rate ?? 0,
        taxInclusive ?? co.tax_inclusive,
      )
      if (!totals.ok) return NextResponse.json({ error: totals.error }, { status: 400 })
      update.line_items    = totals.totals.lineItems
      update.subtotal      = totals.totals.subtotal
      update.tax_rate      = totals.totals.taxRate
      update.tax_inclusive = totals.totals.taxInclusive
      update.total         = totals.totals.total
    }

    // Guarded on the write itself: a send that lands between the checks above and this update
    // must not be overwritten by a stale edit.
    const { data: written, error: updateErr } = await (service as any)
      .from('change_orders').update(update).eq('id', id).eq('status', 'draft').select('id')
    if (updateErr) throw new Error(updateErr.message)
    if (!written || written.length === 0)
      return NextResponse.json({ error: 'This change order was sent and can no longer be edited.' }, { status: 409 })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('CO PATCH error:', err)
    return NextResponse.json({ error: 'Could not save this change order. Please try again.' }, { status: 500 })
  }
}
