import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { roundCurrency, PLAN_LIMITS } from '@/lib/utils/format'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: CREATE_PROJECTS' }, { status: 403 })

    const body = await request.json()
    const { clientId, newClient, name, disc, type, contractValue, currency, startDate, internalRef, retainerDurationMonths } = body

    if (!name?.trim() || !type)
      return NextResponse.json({ error: 'Name and type are required' }, { status: 400 })

    // FIX (deep audit, section 7 — flagship finding): retainer_duration_months
    // is read by api/cron/retainer-milestones, which only ever considers
    // projects where it's NOT NULL — but nothing wrote this column
    // anywhere (not here, not PATCH /api/projects/[id], no settings page).
    // It was permanently null for every project, so the monthly
    // retainer-billing cron matched zero projects, ever. Accept it here
    // for type='retainer' the same way contractValue/currency are
    // accepted; a stray value for a non-retainer type is just ignored
    // rather than erroring, since it has no effect on anything for those
    // types.
    let retainerDuration: number | null = null
    if (type === 'retainer' && retainerDurationMonths != null && retainerDurationMonths !== '') {
      const parsed = parseInt(retainerDurationMonths, 10)
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 60)
        return NextResponse.json({ error: 'Retainer duration must be between 1 and 60 months' }, { status: 400 })
      retainerDuration = parsed
    }

    // FIX (section-11 audit, pass 2): currency was taken straight from the
    // request body with no normalization. The dropdown in the new-project
    // UI only ever sends fixed uppercase codes, so this doesn't misfire
    // through normal use — but evaluateApprovalGate() compares
    // threshold_currency to this value with a case-sensitive `===`, and
    // approval-workflow thresholds are stored uppercase (POST /api/
    // approval-workflows already does `.toUpperCase()`). Any future
    // integration/import path that writes projects.currency without going
    // through that one dropdown (e.g. lowercase "usd") would silently
    // never match a "USD" threshold — a fail-open gate miss with nothing
    // surfaced anywhere. Normalizing at the one place currency is ever
    // written closes that off regardless of what calls this route next.
    const normalizedCurrency = currency ? String(currency).trim().toUpperCase() : null

    const service   = createServiceClient()

    // FIX (deep audit, section 7): PLAN_LIMITS.projects is defined and
    // displayed to the user (Settings → Billing: "2 projects" / "Unlimited
    // projects") but was never actually enforced anywhere — unlike seats,
    // which app/api/team/invite/route.ts does check. A Solo or Starter
    // workspace could create unlimited projects for free.
    const projectLimit = PLAN_LIMITS[session.planTier]?.projects
    if (projectLimit != null) {
      const { count: existingCount } = await (service as any)
        .from('projects').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).is('deleted_at', null)
      if ((existingCount || 0) >= projectLimit) {
        return NextResponse.json({
          error: `Your ${PLAN_LIMITS[session.planTier].name} plan is limited to ${projectLimit} project${projectLimit === 1 ? '' : 's'}. Upgrade to create more.`,
        }, { status: 403 })
      }
    }

    let resolvedClientId = clientId

    // ── Create client if new ──────────────────────────────────
    // FIX (deep audit, section 14 — flagship finding, traced from clients):
    // api/clients/route.ts POST and api/clients/[id]/route.ts PATCH both
    // now require VIEW_CLIENT_DATA in addition to CREATE_PROJECTS before
    // writing a client's email — this third, independent client-write path
    // (create-project-with-a-brand-new-client) never got either fix: no
    // VIEW_CLIENT_DATA gate, and no EMAIL_RE format check before the value
    // is stored as the address every invoice/SOW/CO for this client
    // actually gets sent to. Same two checks, same reasoning, applied here.
    if (!resolvedClientId && newClient?.name && newClient?.email) {
      if (!hasPermission(session, 'VIEW_CLIENT_DATA'))
        return NextResponse.json({ error: 'Missing permission: VIEW_CLIENT_DATA' }, { status: 403 })
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!EMAIL_RE.test(newClient.email.trim()))
        return NextResponse.json({ error: 'Please enter a valid email address for the new client' }, { status: 400 })

      // Check for duplicate email in this workspace
      const { data: existing } = await (service as any)
        .from('clients')
        .select('id, name, status')
        .eq('workspace_id', session.workspaceId)
        .eq('email', newClient.email.toLowerCase().trim())
        .single()

      if (existing) {
        resolvedClientId = existing.id
        // FIX (re-audit, Clients section): reusing an existing client by
        // matched email silently kept whatever status they already had —
        // an archived client (someone the agency marked "done working
        // with") could get attached to a brand-new active project and stay
        // tagged "Archived" everywhere, including the Clients list, which
        // hides archived clients by default. Starting a new project with
        // them is an unambiguous "we're working with them again" signal.
        if (existing.status === 'archived') {
          await (service as any).from('clients').update({ status: 'active' }).eq('id', existing.id)
          await (service as any).from('audit_log').insert({
            workspace_id: session.workspaceId, actor_id: session.id,
            actor_email: session.email, actor_name: session.name,
            event_type: 'client.reactivated', entity_type: 'client',
            entity_id: existing.id, entity_name: existing.name,
            metadata: { reason: 'new_project' },
          })
        }
      } else {
        const { data: created, error: clientErr } = await (service as any)
          .from('clients')
          .insert({
            workspace_id: session.workspaceId,
            name:         newClient.name.trim(),
            email:        newClient.email.toLowerCase().trim(),
          })
          .select('id')
          .single()
        if (clientErr) throw new Error(clientErr.message)
        resolvedClientId = created.id
      }
    }

    if (!resolvedClientId)
      return NextResponse.json({ error: 'Client is required' }, { status: 400 })

    // FIX (audit round 4, finding #2 — HIGH): an explicitly-passed
    // clientId (the "pick an existing client" path — the newClient
    // branch above always creates/looks up scoped to this workspace
    // already) was never checked against session.workspaceId before
    // being written into projects.client_id. Exact same bug class
    // already found and fixed for change_orders.project_id (see
    // app/api/co/route.ts, round 3) — a member of Workspace A could
    // point a new project at a client row belonging to Workspace B,
    // leaking that client's name/email/billing address/VAT into A on
    // every subsequent read (PDFs, portal sends, invoices all join
    // projects → clients with no re-check), and potentially emailing an
    // unrelated agency's real client under A's branding.
    if (clientId) {
      const { data: client } = await (service as any)
        .from('clients').select('id, name, status').eq('id', clientId).eq('workspace_id', session.workspaceId).maybeSingle()
      if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      // FIX (re-audit, Clients section): an archived client could be picked
      // from the "search existing clients" list here with zero warning and
      // zero effect on their status — the archive feature only ever showed
      // up on the Clients list page itself. A new active project is a clear
      // signal they're no longer archived; reactivate them the same way the
      // inline-new-client-by-email-match path above now does.
      if (client.status === 'archived') {
        await (service as any).from('clients').update({ status: 'active' }).eq('id', client.id)
        await (service as any).from('audit_log').insert({
          workspace_id: session.workspaceId, actor_id: session.id,
          actor_email: session.email, actor_name: session.name,
          event_type: 'client.reactivated', entity_type: 'client',
          entity_id: client.id, entity_name: client.name,
          metadata: { reason: 'new_project' },
        })
      }
    }

    // ── Create project ────────────────────────────────────────
    const { data: project, error: projErr } = await (service as any)
      .from('projects')
      .insert({
        workspace_id:   session.workspaceId,
        client_id:      resolvedClientId,
        name:           name.trim(),
        disc:           disc?.trim() || null,
        type,
        status:         'Draft',
        contract_value: roundCurrency(parseFloat(contractValue) || 0),
        currency:       normalizedCurrency || 'USD',
        start_date:     startDate || null,
        internal_ref:   internalRef?.trim() || null,
        retainer_duration_months: retainerDuration,
        created_by:     session.id,
      })
      .select('id')
      .single()

    if (projErr) throw new Error(projErr.message)

    // Auto-add creator to project_members
    const { data: member } = await (service as any)
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', session.workspaceId)
      .eq('user_id', session.id)
      .single()

    if (member) {
      await (service as any).from('project_members').insert({
        project_id: project.id,
        member_id:  member.id,
        added_by:   session.id,
      })
    }

    // Audit log
    await (service as any).from('audit_log').insert({
      workspace_id: session.workspaceId,
      actor_id:     session.id,
      actor_email:  session.email,
      actor_name:   session.name,
      event_type:   'project.created',
      entity_type:  'project',
      entity_id:    project.id,
      entity_name:  name.trim(),
      metadata:     { type, contract_value: contractValue, currency },
    })

    return NextResponse.json({ projectId: project.id })
  } catch (err) {
    console.error('Project create error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service    = createServiceClient()
    const canViewAll = hasPermission(session, 'VIEW_ALL_PROJECTS')

    let query = (service as any)
      .from('projects')
      .select('id,name,status,type,contract_value,currency,clients(id,name)')
      .eq('workspace_id', session.workspaceId)
      .is('deleted_at', null)
      .order('name')

    if (!canViewAll) {
      // FIX: project_members has neither workspace_id nor user_id columns
      // (it links to workspace_members via member_id, which links to users
      // via user_id) — this query referenced two nonexistent columns, so it
      // always errored and silently resolved to an empty list, meaning
      // anyone with only VIEW_OWN_PROJECTS saw zero projects, always,
      // regardless of actual assignments.
      const { data: ids } = await (service as any)
        .from('project_members')
        .select('project_id, workspace_members!inner(user_id)')
        .eq('workspace_members.user_id', session.id)
      query = query.in('id', (ids || []).map((r: any) => r.project_id))
    }

    const { data: projects } = await query
    return NextResponse.json({ projects: projects || [] })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
