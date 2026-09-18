import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { workspaceId } = await request.json()
    if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })
    const service = createServiceClient()

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this
    // route only ever checked `created_by = user.id` — no active-
    // membership check at all, unlike every other write in this section
    // (branding/defaults/settings all go through getSession(), leave/
    // switch explicitly re-check membership). Migration 038 only blocks
    // *leaving* a TRIAL workspace you created; a creator of an upgraded
    // workspace can leave it normally and then retain a permanent,
    // unauthenticated-by-role ability to force-complete onboarding on a
    // workspace they're no longer a member of. Require the caller to
    // still hold an active membership, same as everything else here.
    const { data: membership } = await (service as any)
      .from('workspace_members')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle()
    if (!membership) {
      return NextResponse.json({ error: 'Workspace not found, or you don\u2019t have permission to complete onboarding for it.' }, { status: 404 })
    }

    // FIX (section-by-section re-audit, Workspace lifecycle Finding 4):
    // Supabase resolves `error: null` even when the filter matches zero
    // rows — a stale/mistyped workspaceId, or one that doesn't belong to
    // this user, silently no-op'd and still returned { ok: true }.
    // middleware.ts gates every non-API route on
    // workspace.onboarding_completed_at, so a false-success response
    // here stranded the user in a redirect loop back to /onboarding with
    // no error ever surfaced. Chain .select().maybeSingle() so we can
    // tell whether a row actually changed.
    //
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
    // defense in depth): also exclude a soft-deleted workspace, same gap
    // as lib/auth/session.ts, middleware.ts, onboarding-status, and
    // workspace/list (see the first of those for the full story) — this
    // one was missed in that sweep despite being a write, not a read.
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
    // gap): added .is('onboarding_completed_at', null) so a repeat call
    // (double-click, browser back/forward resubmit) can no longer
    // silently overwrite the ORIGINAL completion timestamp with a later
    // one. That means an already-complete workspace now falls into the
    // !updated branch below alongside a genuinely-not-found one — split
    // those apart so a legitimate repeat call gets a harmless { ok: true }
    // instead of a confusing "not found" error.
    const { data: updated, error } = await (service as any)
      .from('workspaces')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', workspaceId)
      .eq('created_by', user.id)
      .is('deleted_at', null)
      .is('onboarding_completed_at', null)
      .select('id, agency_name')
      .maybeSingle()

    // FIX (Workspace lifecycle, round 4): same info-disclosure pattern
    // workspace/create's own Finding comment already flagged and fixed
    // for itself — raw Postgres error.message was returned straight to
    // the client here too. Log server-side only.
    if (error) {
      console.error('complete-onboarding update failed:', error)
      return NextResponse.json({ error: 'Failed to complete onboarding' }, { status: 500 })
    }

    if (!updated) {
      const { data: alreadyDone } = await (service as any)
        .from('workspaces')
        .select('id')
        .eq('id', workspaceId)
        .eq('created_by', user.id)
        .is('deleted_at', null)
        .not('onboarding_completed_at', 'is', null)
        .maybeSingle()
      if (alreadyDone) return NextResponse.json({ ok: true })
      return NextResponse.json({ error: 'Workspace not found, or you don\u2019t have permission to complete onboarding for it.' }, { status: 404 })
    }

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
    // gap): this is arguably the single most significant milestone in a
    // workspace's lifecycle — the transition from setup to live and
    // governing — yet it was the one write in this whole section with no
    // audit_log entry at all (creation, deletion, settings/branding
    // changes, joining, leaving, and inviting are all logged). Best-
    // effort, same as every other audit-log insert in this section — must
    // never fail an already-successful completion.
    try {
      const { data: userRow } = await (service as any)
        .from('users').select('name').eq('id', user.id).maybeSingle()
      await logAudit(service, {
        workspaceId, actorId: user.id, actorEmail: user.email || '',
        actorName: userRow?.name || user.user_metadata?.name || user.email || '',
        eventType: 'workspace.onboarding_completed', entityType: 'workspace',
        entityId: workspaceId, entityName: updated.agency_name,
      })
    } catch (e) { console.error('workspace.onboarding_completed audit log failed (non-fatal):', e) }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
