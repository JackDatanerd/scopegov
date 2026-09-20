export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { quotePostgrestValue } from '@/lib/audit/search'
import {
  foldedTokens, plainTokens, likePattern, isSearchable, rankBy, searchRateLimited,
} from '@/lib/search/query'

// Global command-palette search: projects, clients (+ their contacts), change
// orders, SOWs, invoices and Guardian flags.
//
// Rewritten in the Notifications & email / Search fix round. What the old
// route got wrong (each verified by running it against Postgres 16 and
// PostgREST 12):
//   • SOW-by-project-name selected `projects(name)` WITHOUT !inner and
//     filtered on the embed, then applied .limit(4) to the parent rows and
//     dropped null embeds in JS — in any workspace with more than four
//     non-draft SOWs it returned four unrelated rows with `projects: null`,
//     all discarded, and never the real match. Now `projects!inner`.
//   • Not one query's `{ error }` was read, so any failure was
//     indistinguishable from "no matches". Every block is now checked; a
//     failed block is reported (`partial`) instead of hidden, and only a
//     total failure is an error response.
//   • projects/clients used stemmed tsquery prefix matching (see
//     lib/search/query.ts for what that broke); now accent-folded substring
//     matching on search_text (migration 061).
//   • No ordering: a bare LIMIT returned an arbitrary handful. Rows are
//     fetched a few extra and ranked by relevance.
//   • ~11 sequential round trips per keystroke. Blocks now run in parallel.
//   • Documents of soft-deleted projects came back and linked to a 404.
//   • Feature gaps closed: a project is found by its CLIENT's name, client
//     contacts are searchable (VIEW_CLIENT_DATA), and Guardian flags match
//     on their SOW reference as well as their description.

type Result = { type: string; id: string; title: string; sub: string; href: string }

const NO_PROJECTS = '00000000-0000-0000-0000-000000000000'
const FETCH = 12 // rows fetched per query before ranking

function must<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return (res.data || []) as T
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const q = new URL(request.url).searchParams.get('q') ?? ''
    if (!isSearchable(q)) return NextResponse.json({ results: [] })

    if (searchRateLimited(session.id))
      return NextResponse.json({ error: 'Too many searches — slow down for a moment.' }, { status: 429 })

    const folded = foldedTokens(q)   // for accent-folded search_text columns
    const plain  = plainTokens(q)    // for ordinary text columns (titles, numbers)
    if (folded.length === 0) return NextResponse.json({ results: [] })
    const wholePlain = plain.join(' ')

    const service           = createServiceClient() as any
    const wsId              = session.workspaceId
    const canViewAll        = hasPermission(session, 'VIEW_ALL_PROJECTS')
    const canViewClientData = hasPermission(session, 'VIEW_CLIENT_DATA')
    const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')

    // Project-scoped visibility, identical to the rest of the app: everything
    // unless the member is limited to projects they're on.
    let restrictedProjectIds: string[] | null = null
    if (!canViewAll) {
      const { data, error } = await service
        .from('project_members').select('project_id, workspace_members!inner(user_id)')
        .eq('workspace_members.user_id', session.id)
      if (error) throw new Error(`project scope: ${error.message}`)
      restrictedProjectIds = (data || []).map((r: any) => r.project_id)
    }
    const nothingVisible = restrictedProjectIds !== null && restrictedProjectIds.length === 0
    const scope = (query: any, column: string) =>
      restrictedProjectIds ? query.in(column, restrictedProjectIds.length ? restrictedProjectIds : [NO_PROJECTS]) : query

    const failed: string[] = []
    const guard = async <T,>(name: string, fn: () => Promise<T[]>): Promise<T[]> => {
      try { return await fn() } catch (e) { console.error(`[search] ${name} failed:`, e); failed.push(name); return [] }
    }
    let blocksRun = 0
    const block = <T,>(name: string, fn: () => Promise<T[]>) => { blocksRun++; return guard(name, fn) }

    // Clients first: their ids also drive "projects of a matching client".
    const clientRows: any[] = await block('clients', async () => {
      let cq = service.from('clients')
        .select('id, name, company_name, email, status')
        .eq('workspace_id', wsId)
      for (const t of folded) cq = cq.ilike('search_text', likePattern(t))
      return must<any[]>(await cq.limit(FETCH))
    })
    const clientMatches = rankBy(clientRows, folded, c => `${c.name} ${c.company_name || ''}`)
    const clientIds = clientMatches.map(c => c.id)

    const seen = new Set<string>()
    const uniq = <T extends { id: string }>(rows: T[]) => rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)))

    const [projectRes, contactRes, coRes, sowRes, invoiceRes, flagRes] = await Promise.all([
      // ── Projects: by their own name/description, or by their client ──
      nothingVisible ? Promise.resolve([] as Result[]) : block('projects', async () => {
        const base = () => scope(service.from('projects')
          .select('id, name, disc, status, clients(name)')
          .eq('workspace_id', wsId).is('deleted_at', null), 'id')
        let own = base()
        for (const t of folded) own = own.ilike('search_text', likePattern(t))
        const byClient = clientIds.length ? base().in('client_id', clientIds).limit(FETCH) : null
        const [a, b] = await Promise.all([own.limit(FETCH), byClient ?? Promise.resolve({ data: [], error: null })])
        const rows = uniq([...must<any[]>(a), ...must<any[]>(b)])
        return rankBy(rows, folded, p => `${p.name} ${p.disc || ''} ${p.clients?.name || ''}`).slice(0, 5).map(p => ({
          type: 'project', id: p.id,
          title: p.name + (p.disc ? ` — ${p.disc}` : ''),
          sub: `${p.clients?.name || ''} · ${p.status}`,
          href: `/projects/${p.id}`,
        }))
      }),

      // ── Client contacts (names and e-mails are client data) ──
      !canViewClientData ? Promise.resolve([] as Result[]) : block('contacts', async () => {
        const base = () => service.from('client_contacts')
          .select('id, name, email, role, client_id, clients!inner(id, name, workspace_id)')
          .eq('clients.workspace_id', wsId)
        let byName = base()
        for (const t of plain) byName = byName.ilike('name', likePattern(t))
        const [a, b] = await Promise.all([
          byName.limit(FETCH),
          // An e-mail is a single string; match the whole query against it.
          base().ilike('email', likePattern(wholePlain)).limit(FETCH),
        ])
        const rows = uniq([...must<any[]>(a), ...must<any[]>(b)])
        return rankBy(rows, plain, c => c.name).slice(0, 3).map(c => ({
          type: 'contact', id: c.id,
          title: c.name,
          sub: `Contact at ${c.clients?.name || 'client'}${c.role ? ` · ${c.role}` : ''}`,
          href: `/clients/${c.client_id}`,
        }))
      }),

      // ── Change orders ──
      nothingVisible ? Promise.resolve([] as Result[]) : block('change orders', async () => {
        const base = () => scope(service.from('change_orders')
          .select('id, title, document_number, status, project_id, projects!inner(name, deleted_at)')
          .eq('workspace_id', wsId).is('projects.deleted_at', null), 'project_id')
        let byTitle = base()
        for (const t of plain) byTitle = byTitle.ilike('title', likePattern(t))
        const [a, b] = await Promise.all([
          byTitle.limit(FETCH),
          base().ilike('document_number', likePattern(wholePlain)).limit(FETCH),
        ])
        const rows = uniq([...must<any[]>(a), ...must<any[]>(b)])
        return rankBy(rows, plain, co => `${co.document_number || ''} ${co.title}`).slice(0, 4).map(co => ({
          type: 'change_order', id: co.id,
          title: co.document_number ? `${co.document_number} — ${co.title}` : co.title,
          sub: `${co.projects?.name || ''} · CO · ${co.status}`,
          href: `/projects/${co.project_id}?tab=co`,
        }))
      }),

      // ── SOWs (drafts excluded — they have no number and aren't registered) ──
      nothingVisible ? Promise.resolve([] as Result[]) : block('SOWs', async () => {
        const base = () => scope(service.from('sow_documents')
          .select('id, status, version, document_number, project_id, projects!inner(name, deleted_at)')
          .eq('workspace_id', wsId).neq('status', 'draft').is('projects.deleted_at', null), 'project_id')
        // FIX: `projects!inner` — see the note at the top of this file.
        let byProject = base()
        for (const t of folded) byProject = byProject.ilike('projects.search_text', likePattern(t))
        const [a, b] = await Promise.all([
          byProject.limit(FETCH),
          base().ilike('document_number', likePattern(wholePlain)).limit(FETCH),
        ])
        const rows = uniq([...must<any[]>(a), ...must<any[]>(b)])
        return rankBy(rows, folded, s => `${s.document_number || ''} ${s.projects.name}`).slice(0, 4).map(s => ({
          type: 'sow', id: s.id,
          title: s.document_number ? `${s.document_number} — ${s.projects.name}` : `SOW — ${s.projects.name}`,
          sub: `v${s.version} · ${s.status}`,
          href: `/projects/${s.project_id}?tab=sow`,
        }))
      }),

      // ── Invoices ──
      (!canViewFinancials || nothingVisible) ? Promise.resolve([] as Result[]) : block('invoices', async () => {
        const base = () => scope(service.from('invoices')
          .select('id, title, invoice_number, status, project_id, projects!inner(name, deleted_at)')
          .eq('workspace_id', wsId).is('projects.deleted_at', null), 'project_id')
        let byTitle = base()
        for (const t of plain) byTitle = byTitle.ilike('title', likePattern(t))
        const [a, b] = await Promise.all([
          byTitle.limit(FETCH),
          base().ilike('invoice_number', likePattern(wholePlain)).limit(FETCH),
        ])
        const rows = uniq([...must<any[]>(a), ...must<any[]>(b)])
        return rankBy(rows, plain, inv => `${inv.invoice_number || ''} ${inv.title}`).slice(0, 4).map(inv => ({
          type: 'invoice', id: inv.id,
          title: inv.invoice_number ? `${inv.invoice_number} — ${inv.title}` : inv.title,
          sub: `${inv.projects?.name || ''} · Invoice · ${inv.status}`,
          href: `/projects/${inv.project_id}?tab=billing`,
        }))
      }),

      // ── Guardian flags: description, or the SOW reference they cite ──
      nothingVisible ? Promise.resolve([] as Result[]) : block('flags', async () => {
        const base = () => scope(service.from('guardian_flags')
          .select('id, description, sow_reference, severity, status, project_id, projects!inner(name, deleted_at)')
          .eq('workspace_id', wsId).is('projects.deleted_at', null)
          .order('created_at', { ascending: false }), 'project_id')
        let byDescription = base()
        for (const t of plain) byDescription = byDescription.ilike('description', likePattern(t))
        const [a, b] = await Promise.all([
          byDescription.limit(FETCH),
          base().ilike('sow_reference', likePattern(wholePlain)).limit(FETCH),
        ])
        const rows = uniq([...must<any[]>(a), ...must<any[]>(b)])
        return rankBy(rows, plain, f => f.description).slice(0, 4).map(f => ({
          type: 'guardian_flag', id: f.id,
          title: f.description.length > 80 ? `${f.description.slice(0, 80)}…` : f.description,
          sub: `${f.projects?.name || ''} · ${f.severity} severity · ${String(f.status).replace(/_/g, ' ')}`,
          href: `/projects/${f.project_id}?tab=guardian`,
        }))
      }),
    ])

    const clientResults: Result[] = clientMatches.slice(0, 4).map(c => ({
      type: 'client', id: c.id, title: c.name,
      sub: [c.company_name || (canViewClientData ? c.email : ''), c.status === 'archived' ? 'Archived' : null]
        .filter(Boolean).join(' · '),
      href: `/clients/${c.id}`,
    }))

    // A contact whose client is already listed adds nothing.
    const listedClients = new Set(clientResults.map(c => c.id))
    const contacts = contactRes.filter(c => !listedClients.has(c.href.replace('/clients/', '')))

    const results: Result[] = [...projectRes, ...clientResults, ...contacts, ...coRes, ...sowRes, ...invoiceRes, ...flagRes]

    // Every block failing is an outage, not "no matches".
    if (failed.length > 0 && failed.length >= blocksRun)
      return NextResponse.json({ results: [], error: 'Search is unavailable right now.' }, { status: 500 })

    return NextResponse.json({ results, query: q.trim(), ...(failed.length ? { partial: true } : {}) })
  } catch (err) {
    console.error('Search error:', err)
    return NextResponse.json({ results: [], error: 'Search is unavailable right now.' }, { status: 500 })
  }
}
