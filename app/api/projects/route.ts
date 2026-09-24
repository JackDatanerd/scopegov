import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { PLAN_LIMITS } from '@/lib/utils/format'
import { insertAuditRow } from '@/lib/utils/audit'
import { LIMIT_COUNTED_STATUSES } from '@/lib/utils/project-status'
import {
  parseProjectName, parseOptionalText, parseProjectType, parseContractValue,
  parseCurrencyCode, parseStartDate, parseRetainerMonths,
  MAX_PROJECT_DISC, MAX_PROJECT_REF,
} from '@/lib/utils/project-input'

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

    // Plan project limit. Pricing advertises "Active projects", so only
    // projects that are still live count (LIMIT_COUNTED_STATUSES). Complete and
    // Archived projects used to count too — and can never be deleted — so a
    // Solo workspace was locked out permanently after its second delivery,
    // and the downgrade error's advice ("archive or delete projects") could
    // not actually get anyone under the limit.
    const projectLimit = PLAN_LIMITS[session.planTier]?.projects
    if (projectLimit != null) {
      const { count: existingCount, error: countErr } = await (service as any)
        .from('projects').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).is('deleted_at', null)
        .in('status', [...LIMIT_COUNTED_STATUSES])
      if (countErr) throw new Error(`plan limit check failed: ${countErr.message}`)
      if ((existingCount || 0) >= projectLimit) {
        return NextResponse.json({
          error: `Your ${PLAN_LIMITS[session.planTier].name} plan is limited to ${projectLimit} active project${projectLimit === 1 ? '' : 's'} (completed and archived projects don't count). Complete or archive one, or upgrade to create more.`,
        }, { status: 403 })
      }
    }

    let resolvedClientId = clientId

    // ── Create client if new ──────────────────────────────────
    // api/clients POST/PATCH require VIEW_CLIENT_DATA before writing a client's
    // email; this create-with-a-brand-new-client path applies the same gate
    // and the same email-format check.
    if (!resolvedClientId && newClient?.name && newClient?.email) {
      if (!hasPermission(session, 'VIEW_CLIENT_DATA'))
        return NextResponse.json({ error: 'Missing permission: VIEW_CLIENT_DATA' }, { status: 403 })
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (typeof newClient.name !== 'string' || typeof newClient.email !== 'string' || !EMAIL_RE.test(newClient.email.trim()))
        return NextResponse.json({ error: 'Please enter a valid email address for the new client' }, { status: 400 })
      // FIX (Projects & Dashboard deep audit): this checked newClient.name was
      // a non-empty string but never `.trim()`ed it first — unlike POST
      // /api/clients, which requires `name?.trim()`. A whitespace-only name
      // passed both checks here and was then stored as `''`
      // (clients.name is NOT NULL with no CHECK on content), silently
      // producing a client with a blank name in every list/dropdown that
      // reads it.
      if (!newClient.name.trim())
        return NextResponse.json({ error: 'Please enter a name for the new client' }, { status: 400 })

      // maybeSingle: `.single()` errors (data:null) on a duplicate, which
      // would fall through to a second insert.
      const { data: existing } = await (service as any)
        .from('clients')
        .select('id, name, status')
        .eq('workspace_id', session.workspaceId)
        .eq('email', newClient.email.toLowerCase().trim())
        .maybeSingle()

      if (existing) {
        resolvedClientId = existing.id
        // Re-using an archived client's email reactivates it (not doing so
        // left the client invisible on the Clients page).
        if (existing.status === 'archived') {
          await (service as any).from('clients').update({ status: 'active' }).eq('id', existing.id)
          await insertAuditRow(service, {
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

    // An explicitly-passed clientId must belong to THIS workspace (otherwise a
    // member of workspace A could attach a project to workspace B's client and
    // read that client's details through every later join).
    if (clientId) {
      if (typeof clientId !== 'string') return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      const { data: client } = await (service as any)
        .from('clients').select('id, name, status').eq('id', clientId).eq('workspace_id', session.workspaceId).maybeSingle()
      if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
      if (client.status === 'archived') {
        await (service as any).from('clients').update({ status: 'active' }).eq('id', client.id)
        await insertAuditRow(service, {
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

    if (projErr) throw new Error(projErr.message)

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
    return NextResponse.json({ projectId: project.id, clientId: resolvedClientId })
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

    let query = (service as any)
      .from('projects')
      .select('id,name,status,type,contract_value,currency,clients(id,name)')
      .eq('workspace_id', session.workspaceId)
      .is('deleted_at', null)
      .order('name')

    if (!canViewAll) {
      // project_members links to workspace_members via member_id (which links
      // to users via user_id) — it has no user_id / workspace_id columns of
      // its own.
      const { data: ids } = await (service as any)
        .from('project_members')
        .select('project_id, workspace_members!inner(user_id)')
        .eq('workspace_members.user_id', session.id)
      query = query.in('id', (ids || []).map((r: any) => r.project_id))
    }

    const { data: projects, error } = await query
    if (error) throw new Error(error.message)
    // Contract values are withheld from members without VIEW_FINANCIALS (the
    // dashboard and project pages already do this — the API didn't).
    const safe = (projects || []).map((p: any) => canViewFinancials ? p : { ...p, contract_value: null })
    return NextResponse.json({ projects: safe })
  } catch (err) {
    console.error('Project list error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
