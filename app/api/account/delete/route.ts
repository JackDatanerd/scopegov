// app/api/account/delete/route.ts
//
// FEATURE (cron audit, section 17 — feature gap): public.users.deleted_at
// is a real column, and app/api/cron/invite-cleanup/route.ts has a fully
// built anonymization branch that finds users with it set (>30 days) and
// scrubs their email/name/avatar — but grep-confirmed across the whole
// app, nothing anywhere ever SET it. No API route, no Settings UI, no
// Supabase Auth deletion trigger. "Leave a workspace" (workspace/leave)
// and "delete a workspace" (workspace/delete) both exist; deleting your
// own account never did. This is that missing producer.
//
// Deliberately a SOFT delete, matching the column's own name and the
// grace-period shape the anonymization cron already expects: this route
// only ever marks deleted_at, never calls Supabase's admin.deleteUser —
// public.users.id is `REFERENCES auth.users(id) ON DELETE CASCADE`, so a
// hard delete there would destroy the row this soft-delete design relies
// on existing for the 30-day anonymization window. The person keeps
// nominal Auth access to their own identity during that window (matching
// how a plain "left every workspace" user already behaves today — see
// below), and is fully scrubbed by the cron after 30 days.
//
// A person can only delete their own account once they can leave every
// workspace they belong to — reusing leave_workspace_atomic (migration
// 027/034/038) for each active membership means this can never orphan a
// workspace (drop it to zero members), leave it without anyone who can
// manage settings or roles, or strand a trial workspace its creator could
// never delete afterward. Those are exactly the same guards the existing
// per-workspace "Leave" action already enforces one at a time; this
// route just runs all of them and only proceeds if every single one
// succeeds. Any workspace that blocks the whole operation is reported
// back with the same guidance the Leave button already gives (transfer
// ownership, reassign the blocking permission, or delete the workspace
// outright) rather than silently leaving some workspaces and not others.
//
// No middleware/getSession() change was needed to make deletion take
// effect immediately: getSession() (lib/auth/session.ts) already returns
// null for a user with zero active workspace_members rows — the exact
// state this route leaves the person in — and every protected page
// already redirects to /login when getSession() returns null (see e.g.
// app/(app)/dashboard/page.tsx). That's the same state "leave every
// workspace one at a time via the existing button" already produces
// today, so this route introduces no new session-handling edge case.

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'

const LEAVE_ERROR_MESSAGES: Record<string, string> = {
  // Same copy as app/api/workspace/leave/route.ts's per-code messages —
  // kept in sync deliberately so a person sees identical guidance whether
  // they hit a blocker via the workspace switcher's "Leave" action or via
  // this route attempting the same leave on their behalf.
  last_member: "you're the only member of this workspace — delete it instead (Settings > Danger Zone)",
  sole_admin: 'you\u2019re the only member who can manage workspace settings there — assign that ability to someone else first (Team > Roles), or delete the workspace',
  sole_roles_admin: 'you\u2019re the only member who can manage roles and permissions there — assign that ability to someone else first (Team > Roles), or delete the workspace',
  trial_creator: 'you created this trial workspace, so leaving would lock you out of starting another trial with no way back in to delete it — delete it instead, or upgrade it off the trial plan first',
}

export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Require the person to type their own email to confirm — same
    // "type something you can't fat-finger past" pattern
    // DangerTab/handleDelete already uses for workspace deletion (typing
    // the workspace name), applied to the one identifier that's always
    // unambiguously theirs. Verified server-side, never trusted from the
    // client alone.
    const { confirmEmail } = await request.json().catch(() => ({ confirmEmail: '' }))
    if (!confirmEmail || typeof confirmEmail !== 'string' ||
        confirmEmail.trim().toLowerCase() !== (user.email || '').toLowerCase()) {
      return NextResponse.json({ error: 'Type your account email to confirm' }, { status: 400 })
    }

    const service = createServiceClient()

    const { data: userRow } = await (service as any)
      .from('users').select('name, deleted_at').eq('id', user.id).maybeSingle()
    if (userRow?.deleted_at) return NextResponse.json({ error: 'Account already deleted' }, { status: 409 })

    const actorName = userRow?.name || user.user_metadata?.name || user.email || ''

    const { data: memberships } = await (service as any)
      .from('workspace_members')
      .select('id, workspace_id, workspaces(name)')
      .eq('user_id', user.id).eq('status', 'active')

    const blockers: string[] = []
    for (const m of (memberships || [])) {
      const workspaceName = m.workspaces?.name || 'Untitled workspace'
      const { error: leaveErr } = await (service as any)
        .rpc('leave_workspace_atomic', { p_workspace_id: m.workspace_id, p_user_id: user.id })

      if (leaveErr) {
        // 'not_a_member' means a concurrent leave/removal already cleared
        // this row between the select above and this call — nothing left
        // to block on, treat as already resolved rather than a blocker.
        if (leaveErr.message?.includes('not_a_member')) continue

        const code = Object.keys(LEAVE_ERROR_MESSAGES).find(c => leaveErr.message?.includes(c))
        blockers.push(code
          ? `"${workspaceName}" — ${LEAVE_ERROR_MESSAGES[code]}`
          : `"${workspaceName}" — could not leave this workspace`)
        if (!code) console.error('leave_workspace_atomic failed during account deletion:', leaveErr)
        continue
      }

      await logAudit(service, {
        workspaceId: m.workspace_id, actorId: user.id, actorEmail: user.email || '',
        actorName, eventType: 'member.left', entityType: 'workspace_member', entityId: m.id,
        entityName: workspaceName, metadata: { reason: 'account_deletion' },
      }).catch(() => {})
    }

    // Any workspace that blocked the leave still has this person as an
    // active member — deliberately NOT marking deleted_at in that case,
    // so the account stays fully functional (and the workspaces they DID
    // successfully leave above stay left, same as clicking Leave on each
    // one individually would have done) until every blocker is resolved
    // and this is retried.
    if (blockers.length) {
      return NextResponse.json({
        error: `Resolve these before you can delete your account: ${blockers.join('; ')}.`,
      }, { status: 409 })
    }

    await (service as any).from('users')
      .update({ deleted_at: new Date().toISOString(), active_workspace_id: null })
      .eq('id', user.id)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Account deletion error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
