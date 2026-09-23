// app/(app)/team/page.tsx
// C8: added invited_email and invite_token_expires_at to SELECT so pending
// invites table can show the invitee email and expiry date correctly.

import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import TeamClient from '@/components/team/TeamClient'
import Link from 'next/link'
import { PLAN_LIMITS } from '@/lib/utils/format'
import { permissionsRequireMfa } from '@/lib/auth/mfa-policy'

export const metadata = { title: 'Team' }

export default async function TeamPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const service = createServiceClient()

  const [membersRes, rolesRes, deactivatedRes] = await Promise.all([
    (service as any)
      .from('workspace_members')
      .select(`
        id, status, joined_at, invited_at, effective_permissions, role_id,
        permission_overrides,
        invited_email, invite_token_expires_at,
        users!workspace_members_user_id_fkey(id, name, email, avatar_url),
        roles(id, name)
      `)
      .eq('workspace_id', session.workspaceId)
      .neq('status', 'deactivated')
      .order('created_at'),
    (service as any)
      .from('roles')
      .select('id, name, permissions, is_default, description')
      .eq('workspace_id', session.workspaceId)
      .order('name'),
    // FIX (deep audit, section 6): deactivation was a one-way door — there
    // was no way to even SEE deactivated members in this UI, let alone
    // undo a mistaken or malicious deactivation. Fetch them separately so
    // TeamClient can offer a Reactivate action.
    (service as any)
      .from('workspace_members')
      .select(`
        id, status, deactivated_at, joined_at, role_id, permission_overrides,
        invited_email,
        users!workspace_members_user_id_fkey(id, name, email, avatar_url),
        roles(id, name)
      `)
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'deactivated')
      .order('deactivated_at', { ascending: false }),
  ])

  const canInvite      = hasPermission(session, 'INVITE_MEMBERS')
  const canManageRoles = hasPermission(session, 'MANAGE_ROLES')

  // Everyone on the team can see who is on it. What each person is permitted to
  // do (their permission map and overrides), pending invitees' addresses and
  // the deactivated list are only sent to people whose role lets them act on
  // them — anything sent here is readable in the browser.
  const allMembers = membersRes.data || []
  const stripPermissions = (m: any) => {
    const { effective_permissions, permission_overrides, ...rest } = m
    return canManageRoles ? { ...rest, permission_overrides } : rest
  }
  // FIX (deep audit, Settings + Team re-pass round 2 — LOW/cross-tenant PII):
  // POST /api/team/invite matches the invited address against the users
  // table workspace-wide across the entire platform (no workspace scope on
  // that lookup — by design, so it can warn about a re-invite or reuse an
  // account that predates this workspace) and sets user_id on the new
  // workspace_members row immediately, before the invite is ever accepted,
  // whenever that address already has an account ANYWHERE. The
  // `users!workspace_members_user_id_fkey` join above then resolves that
  // user_id straight to their real name and avatar_url — someone else's
  // account, possibly at a competing agency, with no relationship to this
  // workspace at all. `joined_at` is only ever set on acceptance
  // (see /api/team/invite/[token]/accept and .../signup), so it's the right
  // signal for "has this person actually become a member here" regardless
  // of which of the three lists (pending/expired/deactivated) the row is
  // in — a deactivated row can be a revoked invite that was never accepted,
  // exactly the same leak as pending/expired. invited_email (already known
  // to whoever sent the invite) still identifies the row.
  const redactStrangerProfile = (m: any) => (m.joined_at ? m : { ...m, users: null })

  // Which members have MFA set up, and which hold access that requires it.
  let mfaByUser = new Map<string, boolean>()
  if (canManageRoles) {
    const { data: mfaRows, error: mfaErr } = await (service as any)
      .rpc('workspace_mfa_status', { p_workspace_id: session.workspaceId })
    if (!mfaErr) mfaByUser = new Map((mfaRows || []).map((r: any) => [r.user_id, !!r.has_mfa]))
  }
  const withMfa = (m: any) => {
    const userId = m.users?.id
    const hasMfa = userId && mfaByUser.has(userId) ? mfaByUser.get(userId)! : undefined
    const mfa = hasMfa === undefined ? undefined
      : hasMfa ? 'enrolled'
      : permissionsRequireMfa(m.effective_permissions) ? 'required_missing' : 'none'
    return { ...stripPermissions(m), ...(mfa ? { mfa } : {}) }
  }

  const roles = (rolesRes.data || []).map((r: any) => canManageRoles ? r : ({
    id: r.id, name: r.name, description: r.description, is_default: r.is_default,
  }))
  const active  = allMembers.filter((m: any) => m.status === 'active').map(withMfa)
  const pending = canInvite ? allMembers.filter((m: any) => m.status === 'invited').map(stripPermissions).map(redactStrangerProfile) : []
  const expired = canInvite ? allMembers.filter((m: any) => m.status === 'expired').map(stripPermissions).map(redactStrangerProfile) : []
  const deactivated = canInvite ? (deactivatedRes.data || []).map(stripPermissions).map(redactStrangerProfile) : []

  // FIX (deep audit, Team & Invites re-pass — feature gap): this used to be
  // an unconditional `session.planTier === 'solo' && active.length <= 1`
  // early return, discarding pending/expired/deactivated before TeamClient
  // ever saw them. A workspace reaching Solo with a still-live pending
  // invite (sent on a higher plan, then downgraded before it was accepted —
  // reachable exactly the way the overSeatLimit comment below documents:
  // api/billing/webhook's subscription.create sets plan_tier from an
  // external Paystack change with no seat check) had no way to even SEE
  // that invite, let alone revoke or resend it — the whole page was the
  // upgrade wall, with no escape but upgrading first. Same for a
  // deactivated member sitting on the Deactivated list with nothing to
  // reactivate them into a >1-seat plan for. Only show the wall when there
  // is genuinely nothing else on this page to manage; a viewer without
  // canInvite already sees empty arrays for these three regardless (they
  // couldn't act on the rows anyway), so the wall still applies for them.
  const hasManageableExtras = pending.length > 0 || expired.length > 0 || deactivated.length > 0
  if (session.planTier === 'solo' && active.length <= 1 && !hasManageableExtras) {
    return <SoloUpsell />
  }

  // FIX (deep audit, section 6 — feature gap): this banner used to check
  // `session.planTier === 'solo'` specifically. That covered the cron-
  // driven downgrade paths (trial-expiry and payment-overdue both only
  // ever force a workspace to 'solo'), but api/billing/webhook's own
  // `subscription.create` handler sets plan_tier to WHATEVER plan the
  // Paystack subscription says — with no seat check at all, unlike the
  // self-service /api/billing/upgrade route. A Starter/Pro/Agency
  // workspace that ends up over its own seat cap that way (an external
  // subscription change, not a checkout through this app) got no warning
  // anywhere. Generalize to the actual condition — active members beyond
  // whatever this workspace's current plan actually allows — for every
  // tier, not just Solo.
  const seatLimit = PLAN_LIMITS[session.planTier]?.seats
  const overSeatLimit = seatLimit != null && active.length > seatLimit

  return (
    <TeamClient
      members={active}
      pendingInvites={pending}
      expiredInvites={expired}
      deactivatedMembers={deactivated}
      roles={roles}
      session={session}
      canInvite={canInvite}
      canManageRoles={canManageRoles}
      workspaceId={session.workspaceId}
      overSeatLimit={overSeatLimit}
      seatLimit={seatLimit ?? null}
    />
  )
}

function SoloUpsell() {
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-sub">Collaborate with colleagues on projects and scope governance</p>
        </div>
      </div>
      <div className="surface" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '32px', borderBottom: '1px solid var(--border)', background: 'var(--green)', borderRadius: 'var(--radius) var(--radius) 0 0' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.1em', color: 'rgba(255,255,255,.6)', marginBottom: 8 }}>Solo plan</div>
          <h2 style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 24, color: '#FFF', fontWeight: 400, margin: '0 0 8px' }}>Upgrade to add team members</h2>
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,.75)', lineHeight: 1.7, maxWidth: 440 }}>
            The Solo plan is for individual practitioners. Upgrade to Starter or above to invite colleagues, assign roles, and collaborate on client work.
          </p>
        </div>
        <div style={{ padding: '28px 32px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 24 }}>
            {[
              { plan: 'Starter', price: '$99/mo', seats: '2 seats', color: 'var(--blue)' },
              { plan: 'Pro',     price: '$249/mo', seats: '4 seats', color: 'var(--green)' },
              { plan: 'Agency',  price: '$399/mo', seats: '10 seats', color: 'var(--gold)' },
            ].map(p => (
              <div key={p.plan} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '16px 18px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: p.color, marginBottom: 4 }}>{p.plan}</div>
                <div style={{ fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 20, marginBottom: 4 }}>{p.price}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{p.seats} included</div>
              </div>
            ))}
          </div>
          <Link href="/settings?tab=billing">
            <button className="btn btn-primary" style={{ padding: '10px 24px', fontSize: 13 }}>
              View upgrade options
            </button>
          </Link>
        </div>
      </div>
    </div>
  )
}
