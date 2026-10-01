export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { escapeIlike } from '@/lib/audit/search'
import { getSession, hasPermission } from '@/lib/auth/session'
import { sowStatusLabel, coStatusLabel, invoiceStatusLabel, flagStatusLabel } from '@/lib/utils/format'
import {
  foldedTokens, plainTokens, likePattern, prefixLike, isSearchable, rankBy, searchRateLimited,
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
//     matching on search_text (migration 062).
//   • No ordering: a bare LIMIT returned an arbitrary handful. Rows are
//     fetched a few extra and ranked by relevance.
//   • ~11 sequential round trips per keystroke. Blocks now run in parallel.
//   • Documents of soft-deleted projects came back and linked to a 404.
//   • Feature gaps closed: a project is found by its CLIENT's name, client
//     contacts are searchable (VIEW_CLIENT_DATA), and Guardian flags match
//     on their SOW reference as well as their description.

// Round 2 (Notifications & email / Search, independent pass) — what that pass found and this fixes:
//   • Every block did `.limit(12)` with NO ORDER BY and only then ranked, so ranking merely reordered an
//     arbitrary 12 rows: with more than 12 rows containing a short token the exact match could never be
//     fetched. Each block now also runs a start-of-text (`term%`) query and orders newest-first.
//   • Projects are found by `internal_ref`; SOWs, change orders, invoices and flags are found by their
//     CLIENT's name as well as their project's; client contacts use an accent-folded search_text
//     (migration 073); active team members are searchable by name.

// Round 3 (Search section, independent pass) — what this pass found and fixes:
//   • Projects' own "matching client" sub-query (`byClient`) was the one fetch in the whole file with
//     no ORDER BY at all — every analogous byClientIds fetch on the other four blocks orders
//     newest-first before its LIMIT; this one didn't, so a client with more than FETCH projects could
//     silently lose the actual match to an arbitrary subset. Same for the members block's only query.
//   • Team members were matched with a plain, accent-SENSITIVE ilike on `users.name` — the exact
//     "Cafe never matched Café" gap migrations 062/073 closed for projects/clients/contacts, just never
//     propagated to users when member search was added. Migration 111 gives users the same
//     accent-folded search_text column; members now match on `folded` tokens like everything else.
//   • Member results linked to bare /team with no way to tell which of potentially many rows matched —
//     every other category deep-links to the specific thing (a client id, ?tab=co, ...). /team now
//     honours the same `?highlight=` convention ApprovalsClient/ProjectDetail/BillingTab already use.

// Round 5 (Search section, independent pass) — what this pass found and fixes:
//   • Every start-of-text (`term%`) fetch had no ORDER BY, and none of the blocks had an EXACT-match fetch: in
//     a workspace with more than FETCH rows sharing a prefix ("Acme", "Acme Labs", "Acme Corp" …) the row
//     whose name IS what was typed could fall outside every fetch. Prefix fetches are now ordered newest-first
//     and clients/projects/change orders/invoices also run a case-insensitive whole-name equality fetch.
//   • Contacts were ranked and cut to three BEFORE the ones belonging to an already-listed client were dropped,
//     so a client's own contacts could use up the slots (and the row limit) and crowd out real matches at other
//     clients. Those clients are now excluded in the query, ahead of the limit.

// Round 6 (Search section, independent pass) — what this pass found and fixes:
//   • SOW / change-order / invoice / flag result lines printed the raw database status ("awaiting_signature",
//     "awaiting_response", "partially_paid", "converted to co") while the same document everywhere else in the app
//     shows its label ("Sent", "Partially paid", "CO Created"). They now use the shared label helpers in
//     lib/utils/format.ts. (The palette's other round-6 fix is in components/team/TeamClient.tsx: a member result
//     picked while the Team page was on its Roles tab navigated and then showed nothing.)

type Result = { type: string; id: string; title: string; sub: string; href: string }

const NO_PROJECTS = '00000000-0000-0000-0000-000000000000'
const FETCH = 15 // rows fetched per query before ranking
const NEWEST = { ascending: false } as const

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

    // Fetch a row list once per id even when several queries returned it.
    const dedupe = <T extends { id: string }>(rows: T[]) => {
      const seen = new Set<string>()
      return rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    }
    const wholeFolded = folded.join(' ')

    // Clients first: their ids also drive "projects/documents of a matching client".
    const clientRows: any[] = await block('clients', async () => {
      const base = () => service.from('clients')
        .select('id, name, company_name, email, status')
        .eq('workspace_id', wsId)
      let cq = base()
      for (const t of folded) cq = cq.ilike('search_text', likePattern(t))
      const [a, b, c] = await Promise.all([
        cq.order('created_at', NEWEST).limit(FETCH),
        base().ilike('search_text', prefixLike(wholeFolded)).order('created_at', NEWEST).limit(FETCH),
        // Whole-name equality (no wildcards → case-insensitive `=`): the client whose name IS the query.
        base().ilike('name', escapeIlike(wholePlain)).limit(FETCH),
      ])
      return dedupe([...must<any[]>(a), ...must<any[]>(b), ...must<any[]>(c)])
    })
    const clientMatches = rankBy(clientRows, folded, c => `${c.name} ${c.company_name || ''}`)
    const clientIds = clientMatches.slice(0, FETCH).map(c => c.id)
    const clientResults: Result[] = clientMatches.slice(0, 4).map(c => ({
      type: 'client', id: c.id, title: c.name,
      sub: [c.company_name || (canViewClientData ? c.email : ''), c.status === 'archived' ? 'Archived' : null]
        .filter(Boolean).join(' · '),
      href: `/clients/${c.id}`,
    }))
    // A contact whose client is already listed adds nothing — excluded in the query (ahead of the row limit).
    const listedClientIds = clientResults.map(c => c.id)
    // Documents/flags of a matching client (the document's project belongs to that client).
    const byClientIds = (q: any) => q.in('projects.client_id', clientIds)

    const [projectRes, contactRes, memberRes, coRes, sowRes, invoiceRes, flagRes] = await Promise.all([
      // ── Projects: by their own name/description, or by their client ──
      nothingVisible ? Promise.resolve([] as Result[]) : block('projects', async () => {
        const base = () => scope(service.from('projects')
          .select('id, name, disc, status, internal_ref, clients(name)')
          .eq('workspace_id', wsId).is('deleted_at', null), 'id')
        let own = base()
        for (const t of folded) own = own.ilike('search_text', likePattern(t))
        // FIX (Search section, round 3): was a bare LIMIT with no ORDER BY — the one
        // "matching client" fetch in the file that didn't order newest-first, unlike its
        // three siblings in this same query and every byClientIds fetch below.
        const byClient = clientIds.length ? base().in('client_id', clientIds).order('created_at', NEWEST).limit(FETCH) : null
        const none = Promise.resolve({ data: [], error: null })
        const [a, b, c, d, e] = await Promise.all([
          own.order('created_at', NEWEST).limit(FETCH),
          byClient ?? none,
          base().ilike('search_text', prefixLike(wholeFolded)).order('created_at', NEWEST).limit(FETCH),
          // The reference number people file a project under (shown on the project header).
          base().ilike('internal_ref', likePattern(wholePlain)).order('created_at', NEWEST).limit(FETCH),
          // The project whose name IS the query (see the round-5 note at the top).
          base().ilike('name', escapeIlike(wholePlain)).limit(FETCH),
        ])
        const rows = dedupe([...must<any[]>(a), ...must<any[]>(b), ...must<any[]>(c), ...must<any[]>(d), ...must<any[]>(e)])
        return rankBy(rows, folded, p => `${p.name} ${p.disc || ''} ${p.internal_ref || ''} ${p.clients?.name || ''}`).slice(0, 5).map(p => ({
          type: 'project', id: p.id,
          title: p.name + (p.disc ? ` — ${p.disc}` : ''),
          sub: [p.clients?.name || '', p.status, p.internal_ref ? `Ref ${p.internal_ref}` : ''].filter(Boolean).join(' · '),
          href: `/projects/${p.id}`,
        }))
      }),

      // ── Client contacts (names and e-mails are client data) ──
      // One accent-folded substring match over name + e-mail + role (migration 073).
      !canViewClientData ? Promise.resolve([] as Result[]) : block('contacts', async () => {
        let cq = service.from('client_contacts')
          .select('id, name, email, role, client_id, clients!inner(id, name, workspace_id)')
          .eq('clients.workspace_id', wsId)
        for (const t of folded) cq = cq.ilike('search_text', likePattern(t))
        if (listedClientIds.length) cq = cq.not('client_id', 'in', `(${listedClientIds.join(',')})`)
        // The query already excludes them; filtering again here is what guarantees a listed client's contacts can never
        // take one of the three slots, whatever the database returned.
        const rows = dedupe(must<any[]>(await cq.order('created_at', NEWEST).limit(FETCH)))
          .filter(c => !listedClientIds.includes(c.client_id))
        return rankBy(rows, folded, c => `${c.name} ${c.email || ''}`).slice(0, 3).map(c => ({
          type: 'contact', id: c.id,
          title: c.name,
          sub: `Contact at ${c.clients?.name || 'client'}${c.role ? ` · ${c.role}` : ''}`,
          href: `/clients/${c.client_id}`,
        }))
      }),

      // ── Team members (active only; names only — e-mails stay on the Team page) ──
      // FIX (Search section, round 3): used to match with a plain, accent-sensitive
      // ilike against users.name — the "Cafe never matched Café" gap already closed
      // for projects/clients/contacts (migrations 062/073), just never propagated to
      // users. Now filters on users.search_text (migration 111) with folded tokens
      // like every other block. Also added the missing ORDER BY (see note at top).
      block('members', async () => {
        let mq = service.from('workspace_members')
          .select('id, users!workspace_members_user_id_fkey!inner(id, name), roles(name)')
          .eq('workspace_id', wsId).eq('status', 'active')
        for (const t of folded) mq = mq.ilike('users.search_text', likePattern(t))
        const rows = dedupe(must<any[]>(await mq.order('created_at', NEWEST).limit(FETCH)))
        return rankBy(rows, folded, m => m.users?.name || '').slice(0, 3).map(m => ({
          type: 'member', id: m.id,
          title: m.users?.name || 'Team member',
          sub: m.roles?.name ? `Team · ${m.roles.name}` : 'Team member',
          // FIX (Search section, round 3 — feature gap): every other category deep-links to
          // the specific thing that matched; this always sent people to bare /team with no
          // way to tell which of potentially many rows was the match. TeamClient now honours
          // this the same way ApprovalsClient/ProjectDetail/BillingTab already use ?highlight=.
          href: `/team?highlight=${m.id}`,
        }))
      }),

      // ── Change orders (title, document number, or their project's name) ──
      // FIX (deep audit, notifications/search re-pass — feature gap): SOWs
      // below have always matched on their project's name (projects!inner
      // is already embedded here for exactly that reason), but change
      // orders never got the same third query — typing a project's name
      // found the project and any SOWs on it, never its change orders.
      nothingVisible ? Promise.resolve([] as Result[]) : block('change orders', async () => {
        const base = () => scope(service.from('change_orders')
          .select('id, title, document_number, status, project_id, projects!inner(name, deleted_at)')
          .eq('workspace_id', wsId).is('projects.deleted_at', null), 'project_id')
        let byTitle = base()
        for (const t of plain) byTitle = byTitle.ilike('title', likePattern(t))
        let byProject = base()
        for (const t of folded) byProject = byProject.ilike('projects.search_text', likePattern(t))
        const none = Promise.resolve({ data: [], error: null })
        const [a, b, c, d, e, f] = await Promise.all([
          byTitle.order('created_at', NEWEST).limit(FETCH),
          base().ilike('document_number', likePattern(wholePlain)).order('created_at', NEWEST).limit(FETCH),
          byProject.order('created_at', NEWEST).limit(FETCH),
          base().ilike('title', prefixLike(wholePlain)).order('created_at', NEWEST).limit(FETCH),
          clientIds.length ? byClientIds(base()).order('created_at', NEWEST).limit(FETCH) : none,
          base().ilike('title', escapeIlike(wholePlain)).limit(FETCH),
        ])
        const rows = dedupe([...must<any[]>(a), ...must<any[]>(b), ...must<any[]>(c), ...must<any[]>(d), ...must<any[]>(e), ...must<any[]>(f)])
        // Ranked with `folded` (not `plain`): a row can now be here purely because it matched the
        // *project's* search_text via a folded token, and plain tokens keep accents SOW's own
        // ranking already avoids for the same reason — see that block below.
        return rankBy(rows, folded, co => `${co.document_number || ''} ${co.title} ${co.projects?.name || ''}`).slice(0, 4).map(co => ({
          type: 'change_order', id: co.id,
          title: co.document_number ? `${co.document_number} — ${co.title}` : co.title,
          sub: `${co.projects?.name || ''} · CO · ${coStatusLabel(String(co.status))}`,
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
        const none = Promise.resolve({ data: [], error: null })
        const [a, b, c] = await Promise.all([
          byProject.order('created_at', NEWEST).limit(FETCH),
          base().ilike('document_number', likePattern(wholePlain)).order('created_at', NEWEST).limit(FETCH),
          clientIds.length ? byClientIds(base()).order('created_at', NEWEST).limit(FETCH) : none,
        ])
        const rows = dedupe([...must<any[]>(a), ...must<any[]>(b), ...must<any[]>(c)])
        return rankBy(rows, folded, s => `${s.document_number || ''} ${s.projects.name}`).slice(0, 4).map(s => ({
          type: 'sow', id: s.id,
          title: s.document_number ? `${s.document_number} — ${s.projects.name}` : `SOW — ${s.projects.name}`,
          sub: `v${s.version} · ${sowStatusLabel(String(s.status))}`,
          href: `/projects/${s.project_id}?tab=sow`,
        }))
      }),

      // ── Invoices (title, invoice number, or their project's name) ──
      // FIX (deep audit, notifications/search re-pass — feature gap): same
      // gap as change orders above — never matched on the project's name.
      (!canViewFinancials || nothingVisible) ? Promise.resolve([] as Result[]) : block('invoices', async () => {
        const base = () => scope(service.from('invoices')
          .select('id, title, invoice_number, status, project_id, projects!inner(name, deleted_at)')
          .eq('workspace_id', wsId).is('projects.deleted_at', null), 'project_id')
        let byTitle = base()
        for (const t of plain) byTitle = byTitle.ilike('title', likePattern(t))
        let byProject = base()
        for (const t of folded) byProject = byProject.ilike('projects.search_text', likePattern(t))
        const none = Promise.resolve({ data: [], error: null })
        const [a, b, c, d, e, f] = await Promise.all([
          byTitle.order('created_at', NEWEST).limit(FETCH),
          base().ilike('invoice_number', likePattern(wholePlain)).order('created_at', NEWEST).limit(FETCH),
          byProject.order('created_at', NEWEST).limit(FETCH),
          base().ilike('title', prefixLike(wholePlain)).order('created_at', NEWEST).limit(FETCH),
          clientIds.length ? byClientIds(base()).order('created_at', NEWEST).limit(FETCH) : none,
          base().ilike('title', escapeIlike(wholePlain)).limit(FETCH),
        ])
        const rows = dedupe([...must<any[]>(a), ...must<any[]>(b), ...must<any[]>(c), ...must<any[]>(d), ...must<any[]>(e), ...must<any[]>(f)])
        // Ranked with `folded` — see the change-orders block above for why.
        return rankBy(rows, folded, inv => `${inv.invoice_number || ''} ${inv.title} ${inv.projects?.name || ''}`).slice(0, 4).map(inv => ({
          type: 'invoice', id: inv.id,
          title: inv.invoice_number ? `${inv.invoice_number} — ${inv.title}` : inv.title,
          sub: `${inv.projects?.name || ''} · Invoice · ${invoiceStatusLabel(String(inv.status))}`,
          href: `/projects/${inv.project_id}?tab=billing`,
        }))
      }),

      // ── Guardian flags: description, the SOW reference they cite, or their project's name ──
      // FIX (deep audit, notifications/search re-pass — feature gap): same
      // gap as change orders/invoices above — never matched on the
      // project's name.
      nothingVisible ? Promise.resolve([] as Result[]) : block('flags', async () => {
        const base = () => scope(service.from('guardian_flags')
          .select('id, description, sow_reference, severity, status, project_id, projects!inner(name, deleted_at)')
          .eq('workspace_id', wsId).is('projects.deleted_at', null)
          .order('created_at', { ascending: false }), 'project_id')
        let byDescription = base()
        for (const t of plain) byDescription = byDescription.ilike('description', likePattern(t))
        let byProject = base()
        for (const t of folded) byProject = byProject.ilike('projects.search_text', likePattern(t))
        const none = Promise.resolve({ data: [], error: null })
        const [a, b, c, d] = await Promise.all([
          byDescription.limit(FETCH),
          base().ilike('sow_reference', likePattern(wholePlain)).limit(FETCH),
          byProject.limit(FETCH),
          clientIds.length ? byClientIds(base()).limit(FETCH) : none,
        ])
        const rows = dedupe([...must<any[]>(a), ...must<any[]>(b), ...must<any[]>(c), ...must<any[]>(d)])
        // Ranked with `folded` — see the change-orders block above for why.
        return rankBy(rows, folded, f => `${f.description} ${f.projects?.name || ''}`).slice(0, 4).map(f => ({
          type: 'guardian_flag', id: f.id,
          title: f.description.length > 80 ? `${f.description.slice(0, 80)}…` : f.description,
          sub: `${f.projects?.name || ''} · ${f.severity} severity · ${flagStatusLabel(String(f.status))}`,
          href: `/projects/${f.project_id}?tab=guardian`,
        }))
      }),
    ])

    const results: Result[] = [...projectRes, ...clientResults, ...contactRes, ...memberRes, ...coRes, ...sowRes, ...invoiceRes, ...flagRes]

    // Every block failing is an outage, not "no matches".
    if (failed.length > 0 && failed.length >= blocksRun)
      return NextResponse.json({ results: [], error: 'Search is unavailable right now.' }, { status: 500 })

    return NextResponse.json({ results, query: q.trim(), ...(failed.length ? { partial: true } : {}) })
  } catch (err) {
    console.error('Search error:', err)
    return NextResponse.json({ results: [], error: 'Search is unavailable right now.' }, { status: 500 })
  }
}
