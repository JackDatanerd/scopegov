// app/api/workspace/restore/route.ts
//
// FEATURE (deep audit, Workspace lifecycle + Onboarding re-pass —
// feature gap): see restore_workspace_atomic's own comment (migration
// 065) for the full story — workspace/delete has never had any way
// back, despite the deletion being soft with a 7-year retention window.
// This is the self-service undo.
//
// Deliberately reachable with NO active workspace membership required:
// the whole point is that the person who deletes their only workspace
// (or the onboarding wizard's own "Discard this workspace" exit panel)
// can land with zero active memberships at all, and would otherwise have
// no page in the app that isn't gated on having one. GET lists what
// they're allowed to restore; POST performs it.

import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { resumePaystackSubscription } from '@/lib/integrations/paystack'
import { alertBillingOps } from '@/lib/billing/ops-alert'
import { sendWorkspaceRestoredEmail } from '@/lib/email/templates'

const RESTORE_WINDOW_DAYS = 30

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const cutoff = new Date(Date.now() - RESTORE_WINDOW_DAYS * 86400000).toISOString()

    // created_by, not membership — a deleted workspace's own memberships
    // are all deactivated, so there is nothing else to check this against.
    // Matches restore_workspace_atomic's own authority check exactly.
    const { data: workspaces } = await (service as any)
      .from('workspaces')
      .select('id, agency_name, name, deleted_at')
      .eq('created_by', user.id)
      .not('deleted_at', 'is', null)
      .gt('deleted_at', cutoff)
      .order('deleted_at', { ascending: false })

    const restorable = (workspaces || []).map((w: any) => ({
      id: w.id,
      agencyName: w.agency_name || w.name || '',
      deletedAt: w.deleted_at,
      restorableUntil: new Date(new Date(w.deleted_at).getTime() + RESTORE_WINDOW_DAYS * 86400000).toISOString(),
    }))

    return NextResponse.json({ restorable })
  } catch (err) {
    console.error('Workspace restorable-list error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Deleted account guard, same reasoning as workspace/create's own —
    // getUser() alone is all that's available here too (a deleted
    // workspace's memberships are gone, so getSession() can't be used).
    const service = createServiceClient()
    const { data: deletedCheck } = await (service as any)
      .from('users').select('deleted_at').eq('id', user.id).maybeSingle()
    if (deletedCheck?.deleted_at) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { workspaceId } = await request.json()
    if (!workspaceId) return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 })

    const { error: rpcError } = await (service as any)
      .rpc('restore_workspace_atomic', { p_workspace_id: workspaceId, p_user_id: user.id })

    if (rpcError) {
      const msg = String(rpcError.message || '')
      if (msg.includes('workspace_not_found')) {
        return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 })
      }
      if (msg.includes('not_deleted')) {
        return NextResponse.json({ error: 'This workspace isn\u2019t deleted.' }, { status: 409 })
      }
      if (msg.includes('not_owner')) {
        return NextResponse.json({ error: 'Only the person who deleted this workspace can restore it.' }, { status: 403 })
      }
      if (msg.includes('restore_window_expired')) {
        return NextResponse.json({
          error: `This workspace was deleted more than ${RESTORE_WINDOW_DAYS} days ago and can no longer be restored. Contact support@scopegov.app if you need help.`,
        }, { status: 409 })
      }
      // FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
      // Restore feature): restore_workspace_atomic's own UPDATE clears
      // deleted_at unconditionally, and can collide with migration 019's
      // one_active_trial_per_creator partial unique index — reachable
      // whenever this SAME creator used the onboarding wizard's own 24h
      // "discard and start over" grace window (migration 048) to spin up
      // a brand-new replacement trial workspace before coming back to
      // restore the original. workspace/create already gives this exact
      // conflict a clear, actionable message; restore fell through to
      // the generic 500 below with no explanation at all. Match create's
      // handling.
      if (rpcError.code === '23505' && msg.includes('one_active_trial_per_creator')) {
        return NextResponse.json({
          error: 'You already have another active trial workspace. Delete or upgrade it first, or contact support@scopegov.app, before restoring this one.',
        }, { status: 409 })
      }
      console.error('restore_workspace_atomic failed:', JSON.stringify(rpcError))
      return NextResponse.json({ error: 'Failed to restore workspace' }, { status: 500 })
    }

    const { data: userRow } = await (service as any)
      .from('users').select('name').eq('id', user.id).maybeSingle()
    const restorerName = userRow?.name || user.user_metadata?.name || user.email || ''

    const { data: ws } = await (service as any)
      .from('workspaces').select('agency_name, name').eq('id', workspaceId).maybeSingle()
    const agencyName = ws?.agency_name || ws?.name || ''

    // Best-effort: reverse the billing-side cancellation workspace/delete
    // required as a precondition. Never blocks the restore, which has
    // already succeeded by this point — same discipline every other
    // best-effort step in this section already follows.
    //
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass —
    // flagship finding): this used to call resumePaystackSubscription and
    // stop there. billing/resume/route.ts's near-identical call to the
    // same helper always follows it with a local write clearing
    // cancels_at_period_end back to false — with its own comment
    // explaining exactly why: "Left as-is, the period-end sweep would
    // downgrade a customer who is still being charged." That write was
    // missing here. Concretely: workspace/delete's cancellation never set
    // cancels_at_period_end itself either, but Paystack's own
    // subscription.disable/not_renew webhook self-heals it to true while
    // the workspace sits deleted — there is no equivalent
    // subscription.enable webhook handler to self-heal the other
    // direction. Left unfixed, a restored-and-still-paying workspace
    // would keep cancels_at_period_end stuck at true indefinitely, and
    // the first time cron/payment-overdue's step 5 finds
    // current_period_end in the past (any renewal-processing lag is
    // enough, since charge.success never touches this flag either) it
    // force-downgrades the workspace to Solo and nulls out its still-live
    // paystack_subscription_code/paystack_customer_code — silently
    // ejecting a paying customer from their plan while Paystack keeps
    // charging them. Mirrors billing/resume's retry-once +
    // alert-a-human-on-persistent-failure discipline exactly, since the
    // failure mode (Paystack re-enabled, local flag stuck) is identical.
    try {
      const { data: billing } = await (service as any)
        .from('billing')
        .select('paystack_subscription_code, paystack_email_token, cancels_at_period_end')
        .eq('workspace_id', workspaceId).maybeSingle()
      if (billing?.paystack_subscription_code) {
        const result = await resumePaystackSubscription(billing)
        if (!result.ok) {
          console.error('Paystack resume after workspace restore failed (non-fatal):', result.error)
        } else if (billing.cancels_at_period_end) {
          const localUpdate = () => (service as any).from('billing').update({
            cancels_at_period_end: false, updated_at: new Date().toISOString(),
          }).eq('workspace_id', workspaceId)
          let upd = await localUpdate()
          if (upd.error) upd = await localUpdate()
          if (upd.error) {
            await alertBillingOps(service, `billing:restore-resume-local-write:${workspaceId}`, 'Resume-on-restore not recorded locally', [
              `workspace: ${workspaceId}`,
              `Paystack subscription was RE-ENABLED on workspace restore but billing.cancels_at_period_end could not be cleared: ${upd.error.message}`,
              'Left as-is, the period-end sweep would downgrade a customer who is still being charged.',
            ])
          }
        }
      }
    } catch (e) { console.error('Billing resume after workspace restore threw (non-fatal):', e) }

    await logAudit(service, {
      workspaceId, actorId: user.id, actorEmail: user.email || '', actorName: restorerName,
      ipAddress: getClientIp(request),
      eventType: 'workspace.restored', entityType: 'workspace', entityId: workspaceId, entityName: agencyName,
    }).catch(() => {})

    // Best-effort — must never block the restore, which has already
    // succeeded by this point. Notifies the restorer and every member
    // whose access just came back (mirrors workspace/delete's own
    // otherMembers notification, in reverse).
    try {
      if (user.email) {
        await sendWorkspaceRestoredEmail({
          to: user.email, name: restorerName, agencyName, restoredByName: restorerName, isRestorer: true,
        }).catch(e => console.error('Workspace restored email (restorer) failed (non-fatal):', e))
      }
      const { data: reactivated } = await (service as any)
        .from('workspace_members')
        .select('user_id, user:users(email, name)')
        .eq('workspace_id', workspaceId).eq('status', 'active')
      for (const m of (reactivated || [])) {
        if (m.user_id === user.id || !m.user?.email) continue
        await sendWorkspaceRestoredEmail({
          to: m.user.email, name: m.user.name || m.user.email, agencyName, restoredByName: restorerName, isRestorer: false,
        }).catch((e: unknown) => console.error('Workspace restored email failed for', m.user.email, e))
      }
    } catch (e) { console.error('Workspace restored notification sweep failed (non-fatal):', e) }

    return NextResponse.json({ ok: true, workspaceId })
  } catch (err) {
    console.error('Workspace restore error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
