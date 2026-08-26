import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sanitizeRichTextOrNull } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      // FIX: CO editor's "Draft with AI" panel needs the client's original
      // wording for COs created from a Guardian flag (draft_co action),
      // not just flag.description (the agency-facing scope-exceedance
      // summary). That original text lives on guardian_checks.content,
      // one hop past the flag via check_id — join both so the client can
      // pre-fill the AI textarea instead of asking the user to retype it.
      .select('*, projects(id,name,currency), guardian_flags(description,severity,sow_reference,guardian_checks(content))')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // FIX (audit round 3): workspace_id was the only scoping check — any
    // workspace member, regardless of project assignment, could fetch any
    // CO's full financial detail. See lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const flagRequestText: string | null = co.guardian_flags?.guardian_checks?.content ?? null
    const { guardian_flags, ...coRest } = co
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

    const body = await request.json()
    const { title, note, lineItems, taxRate, taxInclusive, isRetainerRenewal, timelineImpactDays, scopeImpactNote } = body

    const items    = lineItems || []
    const subtotal = items.reduce((s: number, l: any) => s + (l.quantity * l.rate), 0)
    const tax      = taxInclusive ? 0 : subtotal * (parseFloat(taxRate) || 0) / 100
    const total    = subtotal + tax

    await (service as any).from('change_orders').update({
      title:               title?.trim(),
      note:                sanitizeRichTextOrNull(note),
      line_items:          JSON.stringify(items),
      subtotal,
      tax_rate:            parseFloat(taxRate) || 0,
      tax_inclusive:       taxInclusive || false,
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
