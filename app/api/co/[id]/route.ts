import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sanitizePlainText } from '@/lib/utils/sanitize'
import { canReadProject } from '@/lib/utils/project-access'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data: co } = await (service as any)
      .from('change_orders')
      .select('*, projects(id,name,currency)')
      .eq('id', id).eq('workspace_id', session.workspaceId).single()

    if (!co) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    // FIX (audit round 3): workspace_id was the only scoping check — any
    // workspace member, regardless of project assignment, could fetch any
    // CO's full financial detail. See lib/utils/project-access.ts.
    if (!(await canReadProject(service, session, co.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return NextResponse.json({ co: { ...co, currency: co.projects?.currency } })
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
    const { title, note, lineItems, taxRate, taxInclusive, isRetainerRenewal } = body

    const items    = lineItems || []
    const subtotal = items.reduce((s: number, l: any) => s + (l.quantity * l.rate), 0)
    const tax      = taxInclusive ? 0 : subtotal * (parseFloat(taxRate) || 0) / 100
    const total    = subtotal + tax

    await (service as any).from('change_orders').update({
      title:               title?.trim(),
      note:                note ? sanitizePlainText(note.trim()) || null : null,
      line_items:          JSON.stringify(items),
      subtotal,
      tax_rate:            parseFloat(taxRate) || 0,
      tax_inclusive:       taxInclusive || false,
      total,
      is_retainer_renewal: isRetainerRenewal || false,
      updated_at:          new Date().toISOString(),
    }).eq('id', id)

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
