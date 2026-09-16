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
      .select('id, name, company_name, email')
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
      results.push({
        type:  'client',
        id:    c.id,
        title: c.name,
        sub:   c.company_name || (canViewClientData ? c.email : ''),
        href:  `/clients/${c.id}`,
      })
    }

    // ── Change Orders (title match) ───────────────────────────
    let coQuery = (service as any)
      .from('change_orders')
      .select('id, title, status, project_id, projects(name)')
      .eq('workspace_id', wsId)
      .ilike('title', `%${likeTerm}%`)
      .limit(4)

    if (restrictedProjectIds) {
      coQuery = restrictedProjectIds.length
        ? coQuery.in('project_id', restrictedProjectIds)
        : coQuery.in('project_id', ['00000000-0000-0000-0000-000000000000'])
    }

    const { data: cos } = await coQuery

    for (const co of (cos || [])) {
      results.push({
        type:  'change_order',
        id:    co.id,
        title: co.title,
        sub:   `${co.projects?.name || ''} · CO · ${co.status}`,
        href:  `/projects/${co.project_id}?tab=co`,
      })
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
    let sowQuery = (service as any)
      .from('sow_documents')
      .select('id, status, version, project_id, projects(name)')
      .eq('workspace_id', wsId)
      .neq('status', 'draft')
      .ilike('projects.name', `%${likeTerm}%`)
      .limit(4)

    if (restrictedProjectIds) {
      sowQuery = restrictedProjectIds.length
        ? sowQuery.in('project_id', restrictedProjectIds)
        : sowQuery.in('project_id', ['00000000-0000-0000-0000-000000000000'])
    }

    const { data: sows } = await sowQuery
    for (const s of (sows || [])) {
      if (!s.projects) continue
      results.push({
        type:  'sow',
        id:    s.id,
        title: `SOW — ${s.projects.name}`,
        sub:   `v${s.version} · ${s.status}`,
        href:  `/projects/${s.project_id}?tab=sow`,
      })
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

    return NextResponse.json({ results, query: q })
  } catch (err) {
    console.error('Search error:', err)
    return NextResponse.json({ results: [], error: 'Search failed' })
  }
}
