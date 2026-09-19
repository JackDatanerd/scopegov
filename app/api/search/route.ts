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
    const rawQuery     = q.slice(0, 100)

    // FIX (re-audit, search section): `escaped` used to feed BOTH the
    // to_tsquery construction below AND every ILIKE pattern in this file,
    // stripping only quotes/backslash — which is the wrong sanitization
    // for either use, and actively wrong for one of them:
    //   - It left '%' and '_' untouched, which ARE special to ILIKE
    //     (wildcard / single-char match). A literal '%' or '_' in a search
    //     term (a project called "Q1 100% Launch", an invoice number with
    //     an underscore) silently turned into a wildcard instead of
    //     matching literally — at best surprising over-matching, at worst
    //     (a bare "%") every row in that block up to the .limit().
    //   - It STRIPPED quotes rather than escaping them, so a client
    //     literally named "O'Brien" searched for "OBrien" — a real,
    //     silent non-match on data that's actually there. ILIKE patterns
    //     go through the query-builder's own parameter binding (not raw
    //     filter-DSL text), so there was never a reason to strip quotes
    //     for safety here.
    // escapeIlike below fixes both: escape the LIKE-special characters
    // instead of stripping anything, so a literal '%', '_', or "'" in a
    // search term matches itself.
    const escapeIlike = (raw: string): string =>
      raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    const likeTerm = escapeIlike(rawQuery)

    // FIX (re-audit, search section): to_tsquery has its own reserved
    // operator characters (& | ! ( ) : '), independent of the ILIKE
    // concerns above. The existing fix below (bailing out when the whole
    // query strips to empty) only closed ONE instance of this — a search
    // term of just quotes. Any of & | ! ( ) : left in a token still
    // produces invalid to_tsquery syntax, throws at the Postgres level,
    // and gets silently swallowed by the outer catch into an empty result
    // set indistinguishable from "no matches" — the same "pretends the
    // whole search worked" failure the comment below already flags, just
    // not closed for the rest of the character class. Stripping these
    // (rather than escaping — they're tsquery operators, not literal data
    // in the way '%'/'_' are for ILIKE) keeps the rest of the term
    // searchable instead of failing the whole query.
    const tsSafe  = rawQuery.replace(/['"&|!():\\]/g, '')
    const tsQuery = tsSafe.split(/\s+/).filter(Boolean).map(w => `${w}:*`).join(' & ')

    // FIX (re-audit): the `q.length < 2` guard above runs on the RAW
    // query, before the ['"\] strip — a query like `'''` is 3 raw chars
    // (passes that check) but strips down to an empty string, producing
    // an empty tsQuery. Postgres errors on `to_tsquery('')`, which this
    // route's outer try/catch was silently swallowing into an empty
    // result set with no distinction from "no matches" — technically
    // harmless, but it also skipped straight to Change Orders' plain
    // ilike (which tolerates an empty pattern fine) while pretending the
    // whole search had "worked". Bail out explicitly instead so this
    // stays an intentional no-op, not an unhandled Postgres error caught
    // by accident.
    if (!tsQuery) return NextResponse.json({ results: [] })

    const results: Array<{ type: string; id: string; title: string; sub: string; href: string }> = []

    // FIX (re-audit): computed once and reused below for the Change Orders
    // block, which was still filtering by workspace_id only — same class
    // of gap as the Projects block right below used to have, just never
    // propagated over. See app/api/projects/route.ts for the full
    // explanation of why project_members can't be filtered by workspace_id
    // or user_id directly.
    let restrictedProjectIds: string[] | null = null
    if (!canViewAll) {
      const { data: myIds } = await (service as any)
        .from('project_members').select('project_id, workspace_members!inner(user_id)')
        .eq('workspace_members.user_id', session.id)
      restrictedProjectIds = (myIds || []).map((r: any) => r.project_id)
    }

    // ── Projects ──────────────────────────────────────────────
    let projQuery = (service as any)
      .from('projects')
      .select('id, name, disc, status, clients(name)')
      .eq('workspace_id', wsId)
      .is('deleted_at', null)
      .textSearch('search_vector', tsQuery)
      .limit(5)

    if (restrictedProjectIds) {
      projQuery = restrictedProjectIds.length
        ? projQuery.in('id', restrictedProjectIds)
        : projQuery.in('id', ['00000000-0000-0000-0000-000000000000']) // empty set
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
      .select('id, name, company_name, email, status')
      .eq('workspace_id', wsId)
      .textSearch('search_vector', tsQuery)
      .limit(4)

    // FIX (audit round 4, finding #3): the `sub` fallback exposed client
    // email to any authenticated member with zero permission check,
    // while the Projects/COs blocks right above/below this correctly
    // gate on VIEW_ALL_PROJECTS. Same rule the clients list/detail pages
    // already apply — email only shown to VIEW_CLIENT_DATA holders.
    const canViewClientData = hasPermission(session, 'VIEW_CLIENT_DATA')
    for (const c of (clients || [])) {
      // FIX (deep audit round 2, search section): the canonical Clients
      // list (ClientsClient.tsx) hides archived clients behind a
      // "Show archived (N)" toggle and clearly badges the ones it does
      // show — this block had no status filter and never surfaced status
      // in `sub` at all, so an archived client (which may no longer have
      // active projects, a live contact, or anything else the rest of the
      // app treats as current) looked identical to an active one here,
      // with nothing telling the searcher otherwise. Unlike the list page,
      // this doesn't hide them outright — a global search for an old
      // client by name should still find them — but it now labels status
      // the same way every other result type in this file already does
      // (projects, change orders, invoices all show their status in `sub`).
      const subParts = [c.company_name || (canViewClientData ? c.email : ''), c.status === 'archived' ? 'Archived' : null]
        .filter(Boolean)
      results.push({
        type:  'client',
        id:    c.id,
        title: c.name,
        sub:   subParts.join(' · '),
        href:  `/clients/${c.id}`,
      })
    }

    // ── Change Orders (title or document number match) ─────────
    // FIX (deep audit, search section): change_orders has had a
    // document_number column since migration 003 (same sequential-numbering
    // system invoice_number uses below), but this only ever matched title —
    // typing "CO-0042" found nothing, unlike "INV-0042" for invoices.
    // Same two-query merge pattern as the invoices block, for the same
    // filter-injection reasons (see that block's comment).
    {
      const seenCoIds = new Set<string>()
      const coRows: any[] = []

      const runCoQuery = async (column: 'title' | 'document_number') => {
        let cq = (service as any)
          .from('change_orders')
          .select('id, title, document_number, status, project_id, projects(name)')
          .eq('workspace_id', wsId)
          .ilike(column, `%${likeTerm}%`)
          .limit(4)

        if (restrictedProjectIds) {
          cq = restrictedProjectIds.length
            ? cq.in('project_id', restrictedProjectIds)
            : cq.in('project_id', ['00000000-0000-0000-0000-000000000000'])
        }

        const { data } = await cq
        for (const co of (data || [])) {
          if (seenCoIds.has(co.id)) continue
          seenCoIds.add(co.id)
          coRows.push(co)
        }
      }

      await runCoQuery('title')
      await runCoQuery('document_number')

      for (const co of coRows.slice(0, 4)) {
        results.push({
          type:  'change_order',
          id:    co.id,
          title: co.document_number ? `${co.document_number} — ${co.title}` : co.title,
          sub:   `${co.projects?.name || ''} · CO · ${co.status}`,
          href:  `/projects/${co.project_id}?tab=co`,
        })
      }
    }

    // FIX (build, search section): SOW documents were entirely unsearchable
    // — the command palette frontend already had an icon mapped for a
    // `type: 'sow'` result (TYPE_ICONS in CommandPalette.tsx) that never
    // arrived, and the placeholder text ("Search projects, clients, change
    // orders…") silently reflected the gap by omission. sow_documents has
    // no title/tsvector column of its own (only projects and clients do —
    // see migration 001), so this matches the same way change_orders does:
    // ilike against the *project's* name via an embedded-resource filter
    // (same pattern already used in cron/sow-stall — a non-matching
    // project comes back as a null embed, not a filtered-out row, hence
    // the `if (!s.projects) continue` guard).
    // FIX (deep audit, search section): sow_documents has had a
    // document_number column since migration 003 too, but this only ever
    // matched the *project's* name — the same gap as change_orders above,
    // typing "SOW-0017" found nothing. Merge in a second query matching
    // document_number directly, same dedup pattern as the CO block.
    {
      const seenSowIds = new Set<string>()
      const sowRows: any[] = []

      let sowByProject = (service as any)
        .from('sow_documents')
        .select('id, status, version, document_number, project_id, projects(name)')
        .eq('workspace_id', wsId)
        .neq('status', 'draft')
        .ilike('projects.name', `%${likeTerm}%`)
        .limit(4)
      if (restrictedProjectIds) {
        sowByProject = restrictedProjectIds.length
          ? sowByProject.in('project_id', restrictedProjectIds)
          : sowByProject.in('project_id', ['00000000-0000-0000-0000-000000000000'])
      }
      const { data: sowsByProject } = await sowByProject
      for (const s of (sowsByProject || [])) {
        if (!s.projects || seenSowIds.has(s.id)) continue
        seenSowIds.add(s.id)
        sowRows.push(s)
      }

      let sowByNumber = (service as any)
        .from('sow_documents')
        .select('id, status, version, document_number, project_id, projects(name)')
        .eq('workspace_id', wsId)
        .neq('status', 'draft')
        .ilike('document_number', `%${likeTerm}%`)
        .limit(4)
      if (restrictedProjectIds) {
        sowByNumber = restrictedProjectIds.length
          ? sowByNumber.in('project_id', restrictedProjectIds)
          : sowByNumber.in('project_id', ['00000000-0000-0000-0000-000000000000'])
      }
      const { data: sowsByNumber } = await sowByNumber
      for (const s of (sowsByNumber || [])) {
        if (!s.projects || seenSowIds.has(s.id)) continue
        seenSowIds.add(s.id)
        sowRows.push(s)
      }

      for (const s of sowRows.slice(0, 4)) {
        results.push({
          type:  'sow',
          id:    s.id,
          title: s.document_number ? `${s.document_number} — ${s.projects.name}` : `SOW — ${s.projects.name}`,
          sub:   `v${s.version} · ${s.status}`,
          href:  `/projects/${s.project_id}?tab=sow`,
        })
      }
    }

    // FIX (build, search section): invoices were entirely unsearchable too
    // — gated behind VIEW_FINANCIALS to match the canonical invoices list
    // route (app/api/invoices/route.ts).
    //
    // FIX (re-audit, search section): this used to build a raw `.or(...)`
    // filter-DSL string by hand — `.or()` (unlike `.ilike()`) takes one
    // literal PostgREST filter expression as its argument, where `,`, `(`,
    // `)`, `.` are syntactically significant. `escaped` never accounted
    // for that (it only stripped quotes/backslash), so a search term
    // containing a comma or parens — a client like "Acme, Inc.", a project
    // like "Q3 (final)" — either broke the OR expression outright (silently
    // swallowed to an empty result by the outer catch) or, at the edge,
    // could smuggle an unintended predicate into that OR clause. Every
    // other block in this file avoids the problem entirely by using
    // `.ilike()` as a proper query-builder call (value is bound as a
    // parameter, not spliced into raw DSL text) — doing the same here via
    // two separate queries, merged and deduped in JS, removes the
    // filter-injection surface instead of trying to escape around it.
    if (hasPermission(session, 'VIEW_FINANCIALS')) {
      const seenInvoiceIds = new Set<string>()
      const invoiceRows: any[] = []

      const runInvoiceQuery = async (column: 'title' | 'invoice_number') => {
        let iq = (service as any)
          .from('invoices')
          .select('id, title, invoice_number, status, project_id, projects(name)')
          .eq('workspace_id', wsId)
          .ilike(column, `%${likeTerm}%`)
          .limit(4)

        if (restrictedProjectIds) {
          iq = restrictedProjectIds.length
            ? iq.in('project_id', restrictedProjectIds)
            : iq.in('project_id', ['00000000-0000-0000-0000-000000000000'])
        }

        const { data } = await iq
        for (const inv of (data || [])) {
          if (seenInvoiceIds.has(inv.id)) continue
          seenInvoiceIds.add(inv.id)
          invoiceRows.push(inv)
        }
      }

      await runInvoiceQuery('title')
      await runInvoiceQuery('invoice_number')

      for (const inv of invoiceRows.slice(0, 4)) {
        results.push({
          type:  'invoice',
          id:    inv.id,
          title: inv.invoice_number ? `${inv.invoice_number} — ${inv.title}` : inv.title,
          sub:   `${inv.projects?.name || ''} · Invoice · ${inv.status}`,
          href:  `/projects/${inv.project_id}?tab=billing`,
        })
      }
    }

    // FIX (deep audit, search section — feature gap): guardian_flags —
    // the product's namesake entity, with its own free-text `description`
    // and its own escalation/exception/comment workflow — was entirely
    // absent from search. Unlike projects/clients it has no tsvector
    // column (only projects and clients get one — see migration 001), so
    // this matches the same way change_orders/sow_documents do here:
    // ilike against the one text field that actually carries meaning.
    // Gated the same way every other project-scoped block in this file
    // is — canReadProject's rule (restrictedProjectIds), no extra
    // permission beyond project access, matching guardian/flags/[id]'s
    // own gate.
    let flagQuery = (service as any)
      .from('guardian_flags')
      .select('id, description, severity, status, project_id, projects(name)')
      .eq('workspace_id', wsId)
      .ilike('description', `%${likeTerm}%`)
      .order('created_at', { ascending: false })
      .limit(4)

    if (restrictedProjectIds) {
      flagQuery = restrictedProjectIds.length
        ? flagQuery.in('project_id', restrictedProjectIds)
        : flagQuery.in('project_id', ['00000000-0000-0000-0000-000000000000'])
    }

    const { data: flags } = await flagQuery
    for (const f of (flags || [])) {
      results.push({
        type:  'guardian_flag',
        id:    f.id,
        title: f.description.length > 80 ? `${f.description.slice(0, 80)}…` : f.description,
        sub:   `${f.projects?.name || ''} · ${f.severity} severity · ${f.status.replace(/_/g, ' ')}`,
        href:  `/projects/${f.project_id}?tab=guardian`,
      })
    }

    return NextResponse.json({ results, query: q })
  } catch (err) {
    console.error('Search error:', err)
    return NextResponse.json({ results: [], error: 'Search failed' })
  }
}
