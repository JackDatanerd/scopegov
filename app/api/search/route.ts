import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const q = searchParams.get('q')?.trim()
    if (!q || q.length < 2) return NextResponse.json({ results: [] })

    const service      = createServiceClient()
    const canViewAll   = hasPermission(session, 'VIEW_ALL_PROJECTS')
    const wsId         = session.workspaceId
    const escaped      = q.replace(/['"\\]/g, '').slice(0, 100)
    const tsQuery      = escaped.split(/\s+/).filter(Boolean).map(w => `${w}:*`).join(' & ')

    const results: Array<{ type: string; id: string; title: string; sub: string; href: string }> = []

    // ── Projects ──────────────────────────────────────────────
    let projQuery = (service as any)
      .from('projects')
      .select('id, name, disc, status, clients(name)')
      .eq('workspace_id', wsId)
      .is('deleted_at', null)
      .textSearch('search_vector', tsQuery)
      .limit(5)

    if (!canViewAll) {
      const { data: myIds } = await (service as any)
        .from('project_members').select('project_id')
        .eq('workspace_id', wsId).eq('user_id', session.id)
      const ids = (myIds || []).map((r: any) => r.project_id)
      if (ids.length) projQuery = projQuery.in('id', ids)
      else projQuery = projQuery.in('id', ['00000000-0000-0000-0000-000000000000']) // empty set
    }

    const { data: projects } = await projQuery
    for (const p of (projects || [])) {
      results.push({
        type:  'project',
        id:    p.id,
        title: p.name + (p.disc ? ` — ${p.disc}` : ''),
        sub:   `${p.clients?.name || ''} · ${p.status}`,
        href:  `/projects/${p.id}`,
      })
    }

    // ── Clients ───────────────────────────────────────────────
    const { data: clients } = await (service as any)
      .from('clients')
      .select('id, name, company_name, email')
      .eq('workspace_id', wsId)
      .textSearch('search_vector', tsQuery)
      .limit(4)

    for (const c of (clients || [])) {
      results.push({
        type:  'client',
        id:    c.id,
        title: c.name,
        sub:   c.company_name || c.email,
        href:  `/clients/${c.id}`,
      })
    }

    // ── Change Orders (title match) ───────────────────────────
    const { data: cos } = await (service as any)
      .from('change_orders')
      .select('id, title, status, project_id, projects(name)')
      .eq('workspace_id', wsId)
      .ilike('title', `%${escaped}%`)
      .limit(4)

    for (const co of (cos || [])) {
      results.push({
        type:  'change_order',
        id:    co.id,
        title: co.title,
        sub:   `${co.projects?.name || ''} · CO · ${co.status}`,
        href:  `/projects/${co.project_id}?tab=co`,
      })
    }

    return NextResponse.json({ results, query: q })
  } catch (err) {
    console.error('Search error:', err)
    return NextResponse.json({ results: [], error: 'Search failed' })
  }
}
