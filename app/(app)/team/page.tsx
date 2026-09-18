// app/(app)/team/page.tsx
// C8: added invited_email and invite_token_expires_at to SELECT so pending
// invites table can show the invitee email and expiry date correctly.

import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import TeamClient from '@/components/team/TeamClient'
import Link from 'next/link'
import { PLAN_LIMITS } from '@/lib/utils/format'

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
        id, status, deactivated_at, effective_permissions,
        users!workspace_members_user_id_fkey(id, name, email, avatar_url)
      `)
      .eq('workspace_id', session.workspaceId)
      .eq('status', 'deactivated')
      .order('deactivated_at', { ascending: false }),
  ])

  const members = membersRes.data || []
  const roles   = rolesRes.data  || []
  const active  = members.filter((m: any) => m.status === 'active')
  const pending = members.filter((m: any) => m.status === 'invited')
  // FIX (deep audit, Team & Invites re-pass): the main query already
  // fetches 'expired' rows too (it only excludes 'deactivated'), but they
  // were dropped on the floor here — neither `active` nor `pending`
  // matches status='expired', so cron/invite-cleanup/route.ts flipping a
  // dead invite's status made it vanish from the Team UI entirely, with
  // no "Expired" state ever shown and no way to manually clear it before
  // the 30-day auto-purge. Surface them the same way pending invites are.
  const expired = members.filter((m: any) => m.status === 'expired')
  const deactivated = deactivatedRes.data || []

  // FIX (deep audit, Team & Invites re-pass): this used to hide the whole
  // page behind a Solo-plan upsell whenever planTier === 'solo', no
  // exception. Since plan downgrades were never checked against a
  // workspace's actual seat count (see the /api/billing/upgrade fix), a
  // workspace could already be sitting on Solo with several active
  // members — and this page was the one place that would have let them
  // see and fix that. Only show the upsell for a genuinely single-member
  // workspace; otherwise render the real page (with a banner) so an
  // over-limit workspace can actually deactivate down to what it's paying
  // for instead of being locked out of managing its own team.
  if (session.planTier === 'solo' && active.length <= 1) {
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
      canInvite={hasPermission(session, 'INVITE_MEMBERS')}
      canManageRoles={hasPermission(session, 'MANAGE_ROLES')}
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
