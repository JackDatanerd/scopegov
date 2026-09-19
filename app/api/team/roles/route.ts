import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { permissionsBeyondCeiling } from '@/lib/utils/permission-ceiling'

// Mirrors the same constant in components/team/TeamClient.tsx — the
// allowlist and the copy that describes it must not drift apart again.
const CUSTOM_ROLE_PLANS = ['pro', 'agency', 'trial']

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_ROLES'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_ROLES' }, { status: 403 })

    // FIX (deep audit, Team & Invites section): the allowlist has always
    // included 'trial', but this message said "Pro or Agency plan" —
    // telling a trial workspace it can't do the thing it just did. The
    // client copy was corrected in an earlier pass (CUSTOM_ROLE_PLANS in
    // TeamClient.tsx); the server message it mirrors was missed.
    if (!CUSTOM_ROLE_PLANS.includes(session.planTier))
      return NextResponse.json({ error: 'Custom roles require Pro, Agency, or an active trial' }, { status: 403 })

    const { name, description, permissions, isDefault } = await request.json()
    if (typeof name !== 'string' || !name.trim())
      return NextResponse.json({ error: 'Role name required' }, { status: 400 })
    // FIX (deep audit, Team & Invites section): no length cap existed at
    // all, unlike every comparable field in the codebase (042 caps
    // users.name; sanitizeDisplayName caps agency/workspace names).
    if (name.trim().length > 60)
      return NextResponse.json({ error: 'Role name must be under 60 characters' }, { status: 400 })
    if (permissions !== undefined && (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)))
      return NextResponse.json({ error: 'Invalid permissions payload' }, { status: 400 })
    // FIX (build, Team & Invites section — validation gap): description had
    // no type check or length cap at all, unlike `name` right above it (60
    // chars) and unlike every comparable free-text field elsewhere in the
    // app (workspace/settings' TEXT_FIELD_LIMITS, users.name via migration
    // 042 / sanitizeDisplayName). A non-string value (a number, an object)
    // reached the insert below untouched and surfaced as an opaque 500
    // instead of a clean 400; an unbounded string persisted with no limit
    // into a field the Team page renders as a single line of small text.
    if (description !== undefined && description !== null && typeof description !== 'string')
      return NextResponse.json({ error: 'Invalid description' }, { status: 400 })
    if (typeof description === 'string' && description.trim().length > 300)
      return NextResponse.json({ error: 'Role description must be under 300 characters' }, { status: 400 })

    // FIX (audit round 4, finding #1): MANAGE_ROLES let you shape the
    // workspace's role structure — it was never meant to let you mint a
    // role with permissions you don't personally hold and then assign it
    // to yourself. You can only grant what you already have.
    const beyond = permissionsBeyondCeiling(session, permissions)
    if (beyond.length > 0)
      return NextResponse.json({
        error: `Cannot grant permissions you don't hold yourself: ${beyond.join(', ')}`,
      }, { status: 403 })

    const service = createServiceClient()

    // FIX (deep audit, Team & Invites section): nothing stopped two roles
    // in the same workspace sharing a name. That's not just untidy — the
    // approver pickers in Settings → Approval Workflows, the Role column
    // on the Team page and the invite modal's role <select> all identify
    // a role to the user by name alone, so duplicates are genuinely
    // ambiguous at the point someone is granting access.
    const { data: nameClash } = await (service as any)
      .from('roles').select('id').eq('workspace_id', session.workspaceId)
      .ilike('name', name.trim()).maybeSingle()
    if (nameClash)
      return NextResponse.json({ error: 'A role with that name already exists in this workspace' }, { status: 409 })

    // FIX (deep audit, Team & Invites re-pass — CRITICAL): this used to
    // unset the old default with one UPDATE, then insert the new role as
    // default with a second, entirely separate statement. If the insert
    // failed for any reason after the unset landed (a validation error,
    // a transient DB blip), the workspace was left with ZERO default
    // roles — see migration 049 for the traced downstream consequence
    // (a member joining mid-race gets activated with no role and no
    // permissions at all, silently). Always insert the new role as
    // non-default first; if isDefault was requested, promote it via
    // set_default_role_atomic (migration 049), which unsets the old one
    // and sets the new one in a single transaction. Worst case now if
    // that second step fails: the role exists but isn't (yet) the
    // default — recoverable and visible, never a workspace with none.
    const { data: role, error } = await (service as any).from('roles').insert({
      workspace_id: session.workspaceId,
      name:         name.trim(),
      description:  description?.trim() || null,
      permissions:  permissions || {},
      is_default:   false,
      created_by:   session.id,
    }).select('id').single()

    if (error) throw new Error(error.message)

    let defaultSwapFailed = false
    if (isDefault) {
      const { error: defaultErr } = await (service as any).rpc('set_default_role_atomic', {
        p_workspace_id: session.workspaceId, p_new_role_id: role.id,
      })
      if (defaultErr) {
        console.error('set_default_role_atomic failed:', defaultErr)
        defaultSwapFailed = true
      }
    }

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'workspace.role_created', entityType: 'role',
      entityId: role.id, entityName: name,
      metadata: isDefault ? { requested_default: true, default_swap_failed: defaultSwapFailed } : {},
    })

    return NextResponse.json({
      roleId: role.id,
      ...(defaultSwapFailed ? { warning: 'Role created, but it could not be set as the default — try again from the role list.' } : {}),
    })
  } catch (err) {
    // FIX (deep audit, Team & Invites re-pass): raw exception messages
    // (including error.message re-thrown above) were returned straight to
    // the client — same info-disclosure pattern already fixed elsewhere.
    console.error('Team roles POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()
    const { data: roles } = await (service as any)
      .from('roles').select('id,name,description,permissions,is_default')
      .eq('workspace_id', session.workspaceId).order('name')

    // FIX (build, Team & Invites section — HIGH, info disclosure): this
    // returned the full permissions jsonb for every role in the workspace
    // to any authenticated member, with no MANAGE_ROLES check at all — the
    // exact same "anyone could read the full permission matrix" leak
    // app/(app)/team/page.tsx's own roles query already redacts against
    // (see its comment: "Only ship the permission maps to someone who can
    // actually act on them"). That fix lives entirely in the page's RSC
    // props; it never touched this standalone API route, which is
    // reachable directly and bypasses it completely. No caller in this
    // codebase currently hits this endpoint (TeamClient only ever POSTs to
    // it), but an unused vulnerable route is still a vulnerable route.
    // Mirror the page's own redaction shape exactly, so the two can't
    // silently disagree about what's safe to expose again.
    const canManageRoles = hasPermission(session, 'MANAGE_ROLES')
    const safeRoles = (roles || []).map((r: any) => canManageRoles ? r : ({
      id: r.id, name: r.name, description: r.description, is_default: r.is_default,
    }))

    return NextResponse.json({ roles: safeRoles })
  } catch {
    return NextResponse.json({ error: 'Error' }, { status: 500 })
  }
}
