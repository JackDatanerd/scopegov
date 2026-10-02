import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { wouldExceedLimit, isProjectBeyondLimit, projectLimitMessage } from '@/lib/utils/project-limit'
import { insertAuditRow } from '@/lib/utils/audit'
import { fetchPaged, fetchPagedIn } from '@/lib/utils/paginate'
import { parseClientInput } from '@/lib/utils/client-input'
import { escapeLike, sameEmail } from '@/lib/utils/escape-like'
import {
  parseProjectName, parseOptionalText, parseProjectType, parseContractValue,
  parseCurrencyCode, parseStartDate, parseRetainerMonths,
  MAX_PROJECT_DISC, MAX_PROJECT_REF,
} from '@/lib/utils/project-input'

// FIX (Projects & Dashboard independent pass): a plain, unbounded .select()
// against `projects` — PostgREST silently caps a plain select at 1000 rows
// (see lib/utils/paginate.ts), which this same codebase already guards
// against for exactly this shape of read in lib/reports/scope-health.ts and
// lib/reports/portfolio-data.ts, but not here. Complete/Archived projects
// never count against any plan's project limit (lib/utils/project-limit.ts),
// so a mature workspace's total project count is genuinely unbounded and can
// plausibly cross 1000 over enough years — at which point this endpoint
// would silently return a truncated list with no error and no signal
// anything was cut off.
const PROJECTS_MAX_ROWS = 20000

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_PROJECTS' }, { status: 403 })

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object')
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    const { clientId, newClient, disc, contractValue, currency, startDate, internalRef, retainerDurationMonths } = body

    // Projects & Dashboard deep audit: every free-form field is validated the
    // same way PATCH /api/projects/[id] validates it (lib/utils/project-input).
    // Invalid input used to reach Postgres and come back as a 500 carrying the
    // raw database message; negative contract values were accepted outright.
    const nameP = parseProjectName(body.name)
    if (!nameP.ok) return NextResponse.json({ error: nameP.error }, { status: 400 })
    if (!body.type) return NextResponse.json({ error: 'Name and type are required' }, { status: 400 })
    const typeP = parseProjectType(body.type)
    if (!typeP.ok) return NextResponse.json({ error: typeP.error }, { status: 400 })
    const valueP = parseContractValue(contractValue)
    if (!valueP.ok) return NextResponse.json({ error: valueP.error }, { status: 400 })
    const discP = parseOptionalText(disc, 'Subtitle', MAX_PROJECT_DISC)
    if (!discP.ok) return NextResponse.json({ error: discP.error }, { status: 400 })
    const refP = parseOptionalText(internalRef, 'Internal reference', MAX_PROJECT_REF)
    if (!refP.ok) return NextResponse.json({ error: refP.error }, { status: 400 })
    const dateP = parseStartDate(startDate)
    if (!dateP.ok) return NextResponse.json({ error: dateP.error }, { status: 400 })

    // Currency is normalised (uppercase) at the one place it is ever written:
    // evaluateApprovalGate() compares threshold_currency with a case-sensitive
    // `===` against uppercase stored thresholds.
    let normalizedCurrency = 'USD'
    if (currency !== undefined && currency !== null && currency !== '') {
      const curP = parseCurrencyCode(currency)
      if (!curP.ok) return NextResponse.json({ error: curP.error }, { status: 400 })
      normalizedCurrency = curP.value
    }

    // retainer_duration_months is read by api/cron/retainer-milestones. NULL means an open-ended retainer
    // (billed monthly until the project is completed or archived); a number is a fixed term. A value for a
    // non-retainer type has no effect and is ignored.
    let retainerDuration: number | null = null
    if (typeP.value === 'retainer') {
      const retP = parseRetainerMonths(retainerDurationMonths)
      if (!retP.ok) return NextResponse.json({ error: retP.error }, { status: 400 })
      retainerDuration = retP.value
    }

    const service = createServiceClient()

    // Plan project limit — one shared implementation (lib/utils/project-limit.ts), also enforced on
    // reopen. Re-checked after the insert below to close the count-then-insert race.
    if (await wouldExceedLimit(service, session.workspaceId, session.planTier)) {
      return NextResponse.json({ error: projectLimitMessage(session.planTier, 'create') }, { status: 403 })
    }

    let resolvedClientId = clientId
    // FIX (Projects & Dashboard pass 4 — B2): whether THIS request created the client. The wizard renames "its" client when
    // the user edits the name after stepping Back; a client that already existed under that email is not the wizard's to rename.
    let clientCreated = false
    // FIX (Projects & Dashboard pass 2, B4): an archived client picked for this project used to be reactivated BEFORE the
    // project existed, so a failed insert or a lost plan-limit race left a reactivated client with no project. It is
    // now recorded here and reactivated only once the project has been created and kept.
    let clientToReactivate: { id: string; name: string } | null = null

    // ── Create client if new ──────────────────────────────────
    // api/clients POST/PATCH require VIEW_CLIENT_DATA before writing a client's
    // email; this create-with-a-brand-new-client path applies the same gate
    // and the same email-format check.
    if (!resolvedClientId && newClient?.name && newClient?.email) {
      if (!hasPermission(session, 'VIEW_CLIENT_DATA'))
        return NextResponse.json({ error: 'Missing permission: VIEW_CLIENT_DATA' }, { status: 403 })
      // FIX (independent pass 2, section 14 trace): this branch was a second, weaker copy of POST /api/clients —
      // no length caps (name 200 / email 254), an EXACT-match duplicate lookup (an existing "Jane@Acme.com" was
      // not found for "jane@acme.com", so a case-variant duplicate client was inserted), and a plain insert
      // whose unique-constraint race surfaced as a 500 after the person had filled in the whole project form.
      // It now validates with the same parseClientInput and creates through the same create_client RPC (the
      // duplicate check and insert run under one advisory lock, case-insensitively); an existing client with
      // that address — including one that won a race — is simply reused, as before.
      const parsedClient = parseClientInput({ name: newClient.name, email: newClient.email }, 'create')
      if (!parsedClient.ok) {
        const msg = /email/i.test(parsedClient.error) ? `${parsedClient.error} for the new client` : parsedClient.error
        return NextResponse.json({ error: msg }, { status: 400 })
      }
      const cu = parsedClient.updates as any

      let existingClient: { id: string; name: string; status: string | null } | null = null
      const { data: created, error: clientErr } = await (service as any).rpc('create_client', {
        p_workspace_id: session.workspaceId, p_name: cu.name, p_email: cu.email,
        p_company_name: null, p_cc_emails: [], p_phone: null, p_notes: null, p_timezone: null,
        p_billing_address: null, p_vat_number: null, p_payment_terms_note: null,
      })
      if (clientErr && clientErr.code !== '23505') throw new Error(clientErr.message)

      if (!clientErr && created?.ok) {
        resolvedClientId = created.client_id
        clientCreated = true
        // FIX (independent pass, section 14 trace): clients created through project creation left no
        // `client.created` audit row (POST /api/clients writes one), so the client's history started
        // with an unexplained record.
        await insertAuditRow(service, {
          workspace_id: session.workspaceId, actor_id: session.id,
          actor_email: session.email, actor_name: session.name,
          event_type: 'client.created', entity_type: 'client',
          entity_id: created.client_id, entity_name: cu.name,
          metadata: { via: 'project_creation' },
        })
      } else {
        // Already exists (RPC said so, or the unique constraint did) — look it up case-insensitively.
        let lookup: { data: any } = { data: null }
        if (created?.existing_id) {
          lookup = await (service as any).from('clients').select('id, name, status').eq('id', created.existing_id).eq('workspace_id', session.workspaceId).maybeSingle()
        } else {
          // FIX (independent pass 13, section 14 — B1): escapeLike() can no longer match more than single-character
          // look-alikes of the address (a `*` becomes `_`), but it can still over-match — so take a few candidates and
          // keep only the exact, case-insensitive match instead of whichever row `limit(1)` happened to return.
          const byEmail = await (service as any).from('clients').select('id, name, status, email').eq('workspace_id', session.workspaceId).ilike('email', escapeLike(cu.email)).limit(25)
          lookup = { data: (byEmail?.data || []).find((c: any) => sameEmail(c.email, cu.email)) ?? null }
        }
        existingClient = lookup.data
        if (!existingClient) throw new Error('Could not create or find the client for this email')
        resolvedClientId = existingClient.id
        // Re-using an archived client's email reactivates it (not doing so
        // left the client invisible on the Clients page).
        if (existingClient.status === 'archived') clientToReactivate = { id: existingClient.id, name: existingClient.name }
      }
    }

    if (!resolvedClientId)
      return NextResponse.json({ error: 'Client is required' }, { status: 400 })

    // An explicitly-passed clientId must belong to THIS workspace (otherwise a
    // member of workspace A could attach a project to workspace B's client and
    // read that client's details through every later join).
    if (clientId) {
      if (typeof clientId !== 'string') return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      const { data: client } = await (service as any)
        .from('clients').select('id, name, status').eq('id', clientId).eq('workspace_id', session.workspaceId).maybeSingle()
      if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      if (client.status === 'archived') clientToReactivate = { id: client.id, name: client.name }
    }

    // ── Create project ────────────────────────────────────────
    const { data: project, error: projErr } = await (service as any)
      .from('projects')
      .insert({
        workspace_id:   session.workspaceId,
        client_id:      resolvedClientId,
        name:           nameP.value,
        disc:           discP.value,
        type:           typeP.value,
        status:         'Draft',
        contract_value: valueP.value,
        currency:       normalizedCurrency,
        start_date:     dateP.value,
        internal_ref:   refP.value,
        retainer_duration_months: retainerDuration,
        created_by:     session.id,
      })
      .select('id')
      .single()

    // FIX (independent pass 14, section 14 — B2, traced out of Clients): the client was verified
    // earlier in this request, but a delete / merge-then-delete landing in between fails the
    // projects.client_id foreign key. Report that as the client being gone, not a 500.
    if (projErr?.code === '23503' && /client_id/i.test(projErr.message || ''))
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    if (projErr) throw new Error(projErr.message)

    // Lost the count-then-insert race (a concurrent create took the last slot)? Undo — the project
    // has no children yet, same as the member-insert rollback below.
    if (await isProjectBeyondLimit(service, session.workspaceId, session.planTier, project.id)) {
      await (service as any).from('projects').delete().eq('id', project.id)
      return NextResponse.json({ error: projectLimitMessage(session.planTier, 'create') }, { status: 403 })
    }

    // ── Add creator as project member ─────────────────────────
    // The creator must be a member or a VIEW_OWN_PROJECTS-only user can't open
    // the project they just made. The insert result used to be ignored, so a
    // failure here silently produced a project its creator couldn't see. The
    // project has no children yet, so on failure it is removed and the request
    // fails loudly instead.
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', session.workspaceId)
      .eq('user_id', session.id)
      .maybeSingle()

    if (member) {
      const { error: memberErr } = await (service as any).from('project_members').insert({
        project_id: project.id,
        member_id:  member.id,
        added_by:   session.id,
      })
      if (memberErr) {
        console.error('Project create: could not add creator as member, rolling back:', memberErr)
        await (service as any).from('projects').delete().eq('id', project.id)
        return NextResponse.json({ error: 'Could not create the project. Please try again.' }, { status: 500 })
      }
    }

    // The project exists and is kept: now (and only now) bring an archived client back.
    if (clientToReactivate) {
      const { error: reactErr } = await (service as any).from('clients')
        .update({ status: 'active' }).eq('id', clientToReactivate.id).eq('workspace_id', session.workspaceId).eq('status', 'archived')
      if (reactErr) console.error('Project create: could not reactivate archived client (non-fatal):', reactErr.message)
      else await insertAuditRow(service, {
        workspace_id: session.workspaceId, actor_id: session.id,
        actor_email: session.email, actor_name: session.name,
        event_type: 'client.reactivated', entity_type: 'client',
        entity_id: clientToReactivate.id, entity_name: clientToReactivate.name,
        metadata: { reason: 'new_project' },
      })
    }

    await insertAuditRow(service, {
      workspace_id: session.workspaceId,
      actor_id:     session.id,
      actor_email:  session.email,
      actor_name:   session.name,
      event_type:   'project.created',
      entity_type:  'project',
      entity_id:    project.id,
      entity_name:  nameP.value,
      // The values as STORED (raw input used to be logged: a string, an
      // un-normalised currency).
      metadata:     { type: typeP.value, contract_value: valueP.value, currency: normalizedCurrency },
    })

    // clientId is returned so the wizard can re-use the (possibly just-created) client
    // when the user steps Back and re-submits, instead of creating a second project.
    return NextResponse.json({ projectId: project.id, clientId: resolvedClientId, clientCreated })
  } catch (err) {
    console.error('Project create error:', err)
    return NextResponse.json({ error: 'Could not create the project' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service    = createServiceClient()
    const canViewAll = hasPermission(session, 'VIEW_ALL_PROJECTS')
    const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')

    let restrictedIds: string[] | null = null
    if (!canViewAll) {
      // project_members links to workspace_members via member_id (which links
      // to users via user_id) — it has no user_id / workspace_id columns of
      // its own.
      const { data: ids } = await (service as any)
        .from('project_members')
        .select('project_id, workspace_members!inner(user_id)')
        .eq('workspace_members.user_id', session.id)
      restrictedIds = (ids || []).map((r: any) => r.project_id)
    }

    // FIX (Projects & Dashboard independent pass): fetchPaged so this can
    // never silently truncate at PostgREST's 1000-row cap — see the
    // PROJECTS_MAX_ROWS comment above.
    const listQuery = (from: number, to: number) => (service as any)
      .from('projects')
      .select('id,name,status,type,contract_value,currency,clients(id,name)', { count: 'exact' })
      .eq('workspace_id', session.workspaceId)
      .is('deleted_at', null)
      .order('name')
      .order('id')
      .range(from, to)
    // Restricted members: id list is chunked (section-7 B4) so a long project history can't blow the request URL.
    const page = restrictedIds === null
      ? await fetchPaged<any>((from, to) => listQuery(from, to), { maxRows: PROJECTS_MAX_ROWS })
      : await fetchPagedIn<any>(restrictedIds, (chunk, from, to) => listQuery(from, to).in('id', chunk),
          { maxRows: PROJECTS_MAX_ROWS },
          (a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)))
    if (page.truncated)
      throw new Error(`Project list truncated: workspace exceeded ${PROJECTS_MAX_ROWS} projects`)

    // Contract values are withheld from members without VIEW_FINANCIALS (the
    // dashboard and project pages already do this — the API didn't).
    const safe = page.rows.map((p: any) => canViewFinancials ? p : { ...p, contract_value: null })
    return NextResponse.json({ projects: safe })
  } catch (err) {
    console.error('Project list error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
