// components/team/TeamClient.tsx
// FIX 3C: pending invite table shows invited_email, expiry, + Resend / Revoke buttons
// FIX 3D: invited_email shown first (invitee won't have a users row yet)
// C13: role edit modal (carried forward from previous batch)

'use client'
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { SessionUser } from '@/lib/supabase/types'
import { initials, avatarColour, formatDate, ALL_PERMISSIONS, PLAN_LIMITS } from '@/lib/utils/format'

// FIX (deep audit, section 6 — feature gap): mirrors the exact allowlist
// api/team/roles POST enforces server-side. Kept as one shared constant
// so the "which plans get custom roles" answer can't drift between the
// two again the way it already had (this file previously hardcoded a
// second, narrower ['pro','agency'] copy that silently excluded trial).
const CUSTOM_ROLE_PLANS = ['pro', 'agency', 'trial']

interface Props {
  members:            any[]
  pendingInvites:     any[]
  // FIX (deep audit, Team & Invites re-pass): previously dropped by
  // app/(app)/team/page.tsx the moment cron/invite-cleanup/route.ts
  // flipped a dead invite's status to 'expired' — invisible in this UI
  // with no way to see or clear it before the 30-day auto-purge.
  expiredInvites?:    any[]
  deactivatedMembers?: any[]
  roles:              any[]
  session:            SessionUser
  canInvite:          boolean
  canManageRoles:     boolean
  workspaceId:        string
  // FIX (deep audit, section 6 — feature gap): generalized from a
  // Solo-only check — true whenever this workspace has more active
  // members than its CURRENT plan's seat limit allows, on any tier, not
  // just Solo (see app/(app)/team/page.tsx's own comment for how a
  // non-Solo workspace can end up here). Lets the page still render
  // instead of locking the workspace out of managing its own over-limit
  // team.
  overSeatLimit?:     boolean
  // Paired with overSeatLimit — the seat count the banner below should
  // actually name, instead of a hardcoded "1 seat".
  seatLimit?:         number | null
}

export default function TeamClient({ members, pendingInvites, expiredInvites = [], deactivatedMembers = [], roles, session, canInvite, canManageRoles, workspaceId, overSeatLimit, seatLimit }: Props) {
  const router  = useRouter()
  const searchParams = useSearchParams()
  // FIX (deep audit, section 5 re-pass): Settings computed a `manageRoles`
  // permission and passed it into SettingsClient with no consumer at all —
  // there was no way to land directly on this Roles tab from anywhere in
  // Settings despite the wiring implying one was intended. Support the
  // same `?tab=` deep-link pattern SettingsClient already uses so a link
  // elsewhere in the app can open straight to Roles.
  const [tab,   setTab]   = useState<'members' | 'roles'>(searchParams.get('tab') === 'roles' ? 'roles' : 'members')
  const [modal, setModal] = useState<'invite' | 'role' | null>(null)
  const [inviteEmail,  setInviteEmail]  = useState('')
  const [inviteRoleId, setInviteRoleId] = useState('')
  const [roleName,  setRoleName]  = useState('')
  const [roleDesc,  setRoleDesc]  = useState('')
  const [rolePerms, setRolePerms] = useState<Record<string, boolean>>({})
  const [editRole,  setEditRole]  = useState<any | null>(null)
  const [editPerms, setEditPerms] = useState<Record<string, boolean>>({})
  // FIX (deep audit, Team & Invites re-pass): PATCH /api/team/roles/[id]
  // has always supported editing name/description alongside permissions
  // (and audits which fields changed) — this modal just never had inputs
  // for them, so a role could be named at creation but never renamed.
  const [editName,  setEditName]  = useState('')
  const [editDesc,  setEditDesc]  = useState('')
  // FIX (deep audit, Team & Invites section — CRITICAL feature gap):
  // PATCH /api/team/[id] has always supported reassigning a member's role
  // AND setting per-member permission_overrides, behind a genuinely
  // careful security model — workspace-scoped role lookup,
  // roleWithinCeiling, permissionsBeyondActorForTarget as a floor check,
  // a simulated post-change permission set fed through the admin-floor
  // guard, an APPROVE_DOCUMENTS orphan warning, and audit events that
  // distinguish member.role_changed from member.permission_overridden.
  //
  // None of it had a front door. This component never sent roleId and
  // never sent permissionOverrides; the member card rendered
  // `{m.roles?.name || 'No role'}` as static text. The consequences
  // compounded:
  //   - invite someone into the wrong role and it was permanent; the
  //     only remedy was deactivate + re-invite, which then hit the
  //     unique-constraint 500 in api/team/invite
  //   - DELETE /api/team/roles/[id] refuses with "N active members
  //     currently hold this role. Reassign them first" — pointing at an
  //     action that did not exist, making any role ever assigned
  //     undeletable forever
  //   - permission_overrides — a column, a trigger, and the entire
  //     ceiling/floor model built around it — was 100% unreachable
  //   - Settings' own Transfer Ownership panel tells the owner the
  //     recipient "must already hold Manage workspace settings (Team >
  //     Roles)", which could only be done by editing a shared role and
  //     hitting everyone who held it
  const [roleEditMember, setRoleEditMember] = useState<any | null>(null)
  const [roleEditRoleId, setRoleEditRoleId] = useState('')
  const [overrideMember, setOverrideMember] = useState<any | null>(null)
  const [overrideDraft,  setOverrideDraft]  = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [notice,  setNotice]  = useState('')

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/team/invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail, roleId: inviteRoleId || null, workspaceId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setModal(null); setInviteEmail(''); setInviteRoleId('')
      // FIX (deep audit, Team & Invites re-pass): the invite row is
      // created even when the email fails to send — surface that instead
      // of a plain success message, since otherwise this looks identical
      // to a working invite until the invitee asks why nothing arrived.
      if (json.emailFailed) {
        setNotice('Invite created, but the email couldn\u2019t be sent. Use Resend below to try again.')
      }
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send invite')
    } finally { setLoading(false) }
  }

  async function handleDeactivate(memberId: string, memberName: string) {
    if (!confirm(`Deactivate ${memberName}? They will lose workspace access immediately.`)) return
    setError(''); setNotice('')
    const res = await fetch(`/api/team/${memberId}`, { method: 'DELETE' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setError(json.error || 'Could not deactivate member'); return }
    if (json.warning) setNotice(json.warning)
    router.refresh()
  }

  // FEATURE (deep audit, Auth+MFA section — feature gap): closes the
  // "lost authenticator AND all backup codes" lockout — see
  // api/team/[id]/reset-mfa/route.ts's own comment for the full case.
  async function handleResetMfa(memberId: string, memberName: string) {
    if (!confirm(`Reset two-factor authentication for ${memberName}? They'll need to set it up again the next time their role requires it.`)) return
    setError(''); setNotice('')
    const res = await fetch(`/api/team/${memberId}/reset-mfa`, { method: 'POST' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setError(json.error || 'Could not reset two-factor authentication'); return }
    setNotice(`Two-factor authentication reset for ${memberName}.`)
    router.refresh()
  }

  // FIX (deep audit, Team & Invites section — HIGH, destructive): this
  // was DELETE-then-POST. That shape was itself a fix for an earlier bug
  // (PATCH { status } was a silent no-op so the POST always 409'd), and
  // it solved that — but it turned a retry into a destructive operation.
  // Since DELETE now correctly HARD-deletes a never-accepted invite, a
  // POST that failed for any of four realistic reasons (rate limit — the
  // DELETE doesn't refund the audit row that counts toward the window;
  // seat limit on a plan that changed since; a role that's since been
  // deleted; or the resender holding less than the original inviter)
  // left NOTHING behind: the admin saw an error, the row vanished, and
  // the invitee's still-live link was now dead, with nothing explaining
  // that the invite had been destroyed rather than left alone.
  //
  // Resending doesn't need a new row — it needs a fresh token, a fresh
  // expiry and another email. api/team/[id]/resend does exactly that in
  // place, which is atomic by construction: if anything fails, the
  // invite is exactly as it was. It also preserves role_id, invited_by
  // and invited_at rather than re-attributing the invite to whoever
  // happened to click Resend.
  async function handleResendInvite(m: any) {
    setError(''); setNotice('')
    const res = await fetch(`/api/team/${m.id}/resend`, { method: 'POST' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setError(json.error || 'Could not resend invite'); return }
    setNotice(json.emailFailed
      ? 'Invite refreshed, but the email couldn\u2019t be sent. Try Resend again shortly \u2014 the invite itself is intact.'
      : 'Invite resent. The previous link is no longer valid.')
    router.refresh()
  }

  async function handleRevokeInvite(memberId: string) {
    setError('')
    const res = await fetch(`/api/team/${memberId}`, { method: 'DELETE' })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setError(j.error || 'Could not revoke invite'); return
    }
    router.refresh()
  }

  async function handleReactivate(memberId: string, memberName: string) {
    if (!confirm(`Reactivate ${memberName}? They will regain the access their previous role held.`)) return
    setError(''); setNotice('')
    const res = await fetch(`/api/team/${memberId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setError(json.error || 'Could not reactivate member'); return }
    router.refresh()
  }

  // Reassign a member's role. The server re-verifies the role belongs to
  // this workspace and fits inside the actor's own ceiling, so this only
  // needs to send the id and surface whatever comes back — including the
  // APPROVE_DOCUMENTS orphan warning, which is advisory rather than an
  // error and would otherwise be silently dropped.
  async function handleSaveMemberRole() {
    if (!roleEditMember) return
    setLoading(true); setError(''); setNotice('')
    try {
      const res = await fetch(`/api/team/${roleEditMember.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: roleEditRoleId || null }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      if (json.warning) setNotice(json.warning)
      setRoleEditMember(null); router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not change this member\u2019s role')
    } finally { setLoading(false) }
  }

  // Per-member permission overrides. Deliberately tri-state rather than a
  // flat checkbox grid: compute_effective_permissions (migration 001)
  // merges overrides over the role's permissions per-key, so "not
  // overridden" is a genuinely distinct state from "explicitly false" —
  // collapsing them would silently freeze a member's permissions against
  // future changes to their role, which is the opposite of what an
  // override is for.
  async function handleSaveOverrides() {
    if (!overrideMember) return
    setLoading(true); setError(''); setNotice('')
    try {
      const res = await fetch(`/api/team/${overrideMember.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionOverrides: overrideDraft }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      if (json.warning) setNotice(json.warning)
      setOverrideMember(null); router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save permission overrides')
    } finally { setLoading(false) }
  }

  async function handleCreateRole(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/team/roles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roleName, description: roleDesc, permissions: rolePerms }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setModal(null); setRoleName(''); setRoleDesc(''); setRolePerms({})
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create role')
    } finally { setLoading(false) }
  }

  async function handleEditRole() {
    if (!editRole) return
    if (!editName.trim()) { setError('Role name required'); return }
    setLoading(true); setError(''); setNotice('')
    try {
      const res = await fetch(`/api/team/roles/${editRole.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissions: editPerms, name: editName.trim(), description: editDesc.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      if (json.defaultWarning) setNotice(json.defaultWarning)
      setEditRole(null); router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save role')
    } finally { setLoading(false) }
  }

  // FIX (deep audit, Team & Invites re-pass — feature gap): once a role
  // became the workspace default it could never be reassigned — the only
  // way to change which role new members/invites fall back to was
  // creating an entirely new role at creation time with isDefault checked.
  // PATCH /api/team/roles/[id] now accepts isDefault (see its own comment
  // for why the swap has to go through set_default_role_atomic rather
  // than two separate calls); this is the UI action for it.
  async function handleSetDefaultRole(roleId: string, roleName: string) {
    if (!confirm(`Make "${roleName}" the default role? New members and invites with no role selected will get this role's permissions.`)) return
    setError(''); setNotice('')
    try {
      const res = await fetch(`/api/team/roles/${roleId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      })
      const json = await res.json()
      if (!res.ok) { setError(json.error || 'Could not set default role'); return }
      if (json.defaultWarning) { setError(json.defaultWarning); return }
      router.refresh()
    } catch {
      setError('Could not set default role')
    }
  }

  // FIX (deep audit, section 6): roles could be created but never deleted.
  async function handleDeleteRole(roleId: string, roleName: string) {
    if (!confirm(`Delete the "${roleName}" role? This can't be undone.`)) return
    setError(''); setNotice('')
    const res = await fetch(`/api/team/roles/${roleId}`, { method: 'DELETE' })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setError(json.error || 'Could not delete role'); return }
    router.refresh()
  }

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">Team</h1>
          <p className="page-sub">{members.length} active · {pendingInvites.length} pending invite{pendingInvites.length !== 1 ? 's' : ''}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canInvite && (
            <button className="btn btn-primary" onClick={() => setModal('invite')}>
              <i className="ti ti-user-plus" style={{ fontSize: 13 }} /> Invite member
            </button>
          )}
        </div>
      </div>

      {overSeatLimit && (
        <div className="auth-error" style={{ marginBottom: 16 }}>
          {/* FIX (deep audit, section 6 — feature gap): hardcoded "Solo
             plan (1 seat)" / "down to 1" — now names the workspace's
             actual plan and seat limit so the banner is accurate on
             every tier, not just Solo. */}
          This workspace is on the {PLAN_LIMITS[session.planTier]?.name || session.planTier} plan
          ({seatLimit} seat{seatLimit === 1 ? '' : 's'}) but has {members.length} active members.
          Deactivate members down to {seatLimit}, or upgrade in Settings &rarr; Billing.
        </div>
      )}
      {error && <div className="auth-error" style={{ marginBottom: 16 }}>{error}</div>}
      {notice && <div className="auth-success" style={{ marginBottom: 16 }}>{notice}</div>}

      <div className="tabbar" style={{ marginBottom: 24 }}>
        <button className={`tabi${tab === 'members' ? ' act' : ''}`} onClick={() => setTab('members')}>
          Members ({members.length + pendingInvites.length})
        </button>
        {/* FIX (deep audit, Team & Invites section): the Roles tab rendered
            for everyone — only the buttons inside it were gated — so any
            member could read the full permission matrix for every role in
            the workspace. The permission maps are no longer sent to
            unprivileged members at all (see app/(app)/team/page.tsx), so
            the tab would now render an empty grid; hide it instead. */}
        {canManageRoles && (
          <button className={`tabi${tab === 'roles' ? ' act' : ''}`} onClick={() => setTab('roles')}>
            Roles ({roles.length})
          </button>
        )}
      </div>

      {tab === 'members' && (
        <>
          <div className="member-grid" style={{ marginBottom: 24 }}>
            {members.map((m: any) => {
              const u      = m.users
              const isMe   = u?.id === session.id
              const name   = u?.name || u?.email || 'Unknown'
              const colour = avatarColour(name)
              return (
                <div key={m.id} className="member-card">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    {/* FIX (deep audit, Workspace lifecycle + Onboarding
                        re-pass — feature gap): u.avatar_url has been
                        selected in this query all along but was never
                        actually rendered — every member showed colored
                        initials regardless of whether they'd set a photo,
                        because there was nowhere in the app to set one
                        until now (see api/workspace/profile/avatar/route.ts). */}
                    {u?.avatar_url ? (
                      <img src={u.avatar_url} alt="" className="member-av" style={{ objectFit: 'cover' }} />
                    ) : (
                      <div className="member-av" style={{ background: colour }}>{initials(name)}</div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="member-name">{name} {isMe && <span style={{ fontSize: 10, color: 'var(--green)' }}>you</span>}</div>
                      <div className="member-role">{m.roles?.name || 'No role'}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 12 }}>{u?.email}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Joined {m.joined_at ? formatDate(m.joined_at) : '—'}</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {/* FEATURE (deep audit, Auth+MFA section — feature
                          gap): the only prior way back in for a member
                          locked out of MFA (device lost + backup codes
                          gone) was a self-service backup code — with none
                          left, nothing else in the app could help, not
                          even the workspace owner. Gated the same as every
                          other member-targeting action here (MANAGE_ROLES
                          + the server-side floor check in
                          api/team/[id]/reset-mfa/route.ts) rather than
                          also excluding owners the way Deactivate does —
                          a co-owner should be able to reset a locked-out
                          fellow owner's MFA, which the floor check still
                          correctly allows since neither holds anything
                          the other doesn't. */}
                      {canManageRoles && (
                        <button className="btn btn-ghost btn-xs"
                          onClick={() => { setRoleEditMember(m); setRoleEditRoleId(m.role_id || '') }}>
                          Change role
                        </button>
                      )}
                      {canManageRoles && (
                        <button className="btn btn-ghost btn-xs"
                          title="Grant or revoke individual permissions for this person, on top of their role"
                          onClick={() => { setOverrideMember(m); setOverrideDraft({ ...(m.permission_overrides || {}) }) }}>
                          Overrides
                        </button>
                      )}
                      {!isMe && canManageRoles && (
                        <button className="btn btn-ghost btn-xs" onClick={() => handleResetMfa(m.id, name)}>
                          Reset MFA
                        </button>
                      )}
                      {/* FIX (deep audit, Team & Invites section): Deactivate
                          used to be hidden for every MANAGE_WORKSPACE_SETTINGS
                          holder, while the over-seat banner directly above
                          instructs the person to "Deactivate members down to
                          {seatLimit}". A workspace whose surplus members all
                          hold that permission — the likely shape after an
                          external Paystack downgrade, which this page's own
                          comment identifies as the way in — could not follow
                          its own instruction. The server is the real
                          authority here and already handles it correctly:
                          permissionsBeyondActorForTarget lets a peer admin
                          act on an equal, and refuses anyone reaching above
                          their own ceiling. Only the client was blocking it. */}
                      {!isMe && canInvite && (
                        <button className="btn btn-ghost btn-xs" style={{ color: 'var(--red)', borderColor: '#FECACA' }}
                          onClick={() => handleDeactivate(m.id, name)}>
                          Deactivate
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {canInvite && (
              <div className="invite-slot" onClick={() => setModal('invite')}>
                <i className="ti ti-user-plus" style={{ fontSize: 28, color: 'var(--green)', marginBottom: 10 }} />
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--green)' }}>Invite member</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Send an invitation by email</span>
              </div>
            )}
          </div>

          {pendingInvites.length > 0 && (
            <div>
              <div className="sec-hd"><div className="sec-title">Pending invitations ({pendingInvites.length})</div></div>
              <div className="surface" style={{ overflow: 'hidden' }}>
                <table className="gov-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Email</th><th>Role</th><th>Invited</th><th>Expires</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {pendingInvites.map((m: any) => (
                      <tr key={m.id}>
                        {/* FIX 3C: invited_email first — users row doesn't exist yet for new invitees */}
                        <td className="td-primary">{m.invited_email || m.users?.email || '—'}</td>
                        <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{m.roles?.name || 'Default'}</td>
                        <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatDate(m.invited_at)}</td>
                        <td style={{ color: 'var(--text-3)', fontSize: 12 }}>
                          {m.invite_token_expires_at ? formatDate(m.invite_token_expires_at) : '—'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <span className="pill pill-amber pill-sm">Pending</span>
                            {/* FIX 3D: Resend and Revoke actions */}
                            <button className="btn btn-ghost btn-xs" onClick={() => handleResendInvite(m)}>
                              Resend
                            </button>
                            <button className="btn btn-ghost btn-xs" style={{ color: 'var(--red)' }}
                              onClick={() => handleRevokeInvite(m.id)}>
                              Revoke
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* FIX (deep audit, Team & Invites re-pass): expired invites —
             previously invisible entirely once cron/invite-cleanup marked
             them 'expired'. Same shape as Pending, but Resend is the only
             action that makes sense to lead with since the token is dead;
             Revoke is still offered to clear it immediately rather than
             waiting on the 30-day auto-purge. */}
          {expiredInvites.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <div className="sec-hd"><div className="sec-title">Expired invitations ({expiredInvites.length})</div></div>
              <div className="surface" style={{ overflow: 'hidden' }}>
                <table className="gov-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Email</th><th>Role</th><th>Invited</th><th>Expired</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {expiredInvites.map((m: any) => (
                      <tr key={m.id}>
                        <td className="td-primary">{m.invited_email || m.users?.email || '—'}</td>
                        <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{m.roles?.name || 'Default'}</td>
                        <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatDate(m.invited_at)}</td>
                        <td style={{ color: 'var(--text-3)', fontSize: 12 }}>
                          {m.invite_token_expires_at ? formatDate(m.invite_token_expires_at) : '—'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <span className="pill pill-slate pill-sm">Expired</span>
                            <button className="btn btn-ghost btn-xs" onClick={() => handleResendInvite(m)}>
                              Resend
                            </button>
                            <button className="btn btn-ghost btn-xs" style={{ color: 'var(--red)' }}
                              onClick={() => handleRevokeInvite(m.id)}>
                              Revoke
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* FIX (deep audit, section 6): deactivated members were
             previously invisible in this UI entirely, with no way to undo
             a deactivation. */}
          {canInvite && deactivatedMembers.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <div className="sec-hd"><div className="sec-title">Deactivated ({deactivatedMembers.length})</div></div>
              <div className="surface" style={{ overflow: 'hidden' }}>
                <table className="gov-table" style={{ width: '100%' }}>
                  <thead>
                    <tr><th>Name</th><th>Email</th><th>Deactivated</th><th /></tr>
                  </thead>
                  <tbody>
                    {deactivatedMembers.map((m: any) => {
                      const u = m.users
                      const name = u?.name || u?.email || 'Unknown'
                      return (
                        <tr key={m.id}>
                          <td className="td-primary" style={{ color: 'var(--text-3)' }}>{name}</td>
                          <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{u?.email}</td>
                          <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{m.deactivated_at ? formatDate(m.deactivated_at) : '—'}</td>
                          <td>
                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                              <button className="btn btn-ghost btn-xs" onClick={() => handleReactivate(m.id, name)}>
                                Reactivate
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'roles' && canManageRoles && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
              {/* FIX (deep audit, section 6 — feature gap): this checked
                 ['pro','agency'] only, but api/team/roles POST has always
                 also allowed 'trial' — every trial workspace was entitled
                 to custom roles server-side with no way to reach the
                 feature in the UI, and this copy actively told them
                 otherwise ("Custom roles require Pro or Agency"). Mirror
                 the server's own allowlist exactly instead of a second,
                 drifted copy of it. */}
              {CUSTOM_ROLE_PLANS.includes(session.planTier)
                ? 'Create custom roles for fine-grained access control.'
                : 'Preset roles are available on all plans. Custom roles require Pro, Agency, or an active trial.'}
            </p>
            {canManageRoles && CUSTOM_ROLE_PLANS.includes(session.planTier) && (
              <button className="btn btn-primary btn-sm" onClick={() => setModal('role')}>
                <i className="ti ti-plus" style={{ fontSize: 12 }} /> New role
              </button>
            )}
          </div>
          <div className="surface" style={{ overflow: 'hidden' }}>
            <table className="gov-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Role name</th><th>Description</th>
                  <th style={{ textAlign: 'center' }}>Members</th>
                  <th style={{ textAlign: 'center' }}>Permissions</th><th />
                </tr>
              </thead>
              <tbody>
                {roles.map((r: any) => {
                  const memberCount = members.filter((m: any) => m.role_id === r.id).length
                  const permCount   = Object.values(r.permissions || {}).filter(Boolean).length
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="td-primary">{r.name}</div>
                        {r.is_default && <span className="pill pill-slate pill-sm" style={{ marginTop: 3 }}>Default</span>}
                      </td>
                      <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{r.description || '—'}</td>
                      <td style={{ textAlign: 'center', fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 18 }}>{memberCount}</td>
                      <td style={{ textAlign: 'center' }}>
                        {/* FIX (deep audit, Team & Invites re-pass): hardcoded "/ 24"
                           went stale the moment a 25th permission (APPROVE_DOCUMENTS)
                           was added — derive the denominator from ALL_PERMISSIONS
                           itself so it can't drift out of sync again. */}
                        <span className="pill pill-green pill-sm">{permCount} / {ALL_PERMISSIONS.length}</span>
                      </td>
                      <td>
                        {/* FIX (deep audit, Team & Invites re-pass —
                            feature gap): Edit/Delete used to be hidden
                            outright for the default role, and there was
                            no action anywhere to make a different role
                            the default — the two combined meant the
                            default role's permissions were frozen the
                            moment it became default, permanently. Delete
                            still can't apply to it (a workspace always
                            needs exactly one default — see DELETE's own
                            check), but Edit now works on it like any
                            other role, and non-default rows get a
                            "Make default" action instead of Delete's
                            slot. */}
                        {canManageRoles && (
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                            <button className="btn-icon" onClick={() => { setEditRole(r); setEditPerms(r.permissions || {}); setEditName(r.name || ''); setEditDesc(r.description || '') }}>
                              <i className="ti ti-pencil" style={{ fontSize: 13 }} />
                            </button>
                            {r.is_default ? null : (
                              <>
                                <button className="btn-icon" title="Make this the default role"
                                  onClick={() => handleSetDefaultRole(r.id, r.name)}>
                                  <i className="ti ti-star" style={{ fontSize: 13 }} />
                                </button>
                                <button className="btn-icon" style={{ color: 'var(--red)' }}
                                  title={memberCount > 0 ? 'Reassign members before deleting' : 'Delete role'}
                                  onClick={() => handleDeleteRole(r.id, r.name)}>
                                  <i className="ti ti-trash" style={{ fontSize: 13 }} />
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Invite modal */}
      {modal === 'invite' && (
        <>
          <div className="modal-bg" onClick={() => setModal(null)} />
          <div className="modal">
            <h2 className="modal-title">Invite team member</h2>
            <p className="modal-sub">Send an invitation email. The link expires in 7 days.</p>
            {error && <div className="auth-error">{error}</div>}
            <form onSubmit={handleInvite}>
              <div className="fgrp">
                <label className="flbl">Email address</label>
                <input type="email" className="finp" value={inviteEmail} autoFocus required
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInviteEmail(e.target.value)}
                  placeholder="colleague@youragency.com" />
              </div>
              <div className="fgrp">
                <label className="flbl">Role <span className="fhint">— optional</span></label>
                <select className="finp" value={inviteRoleId}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setInviteRoleId(e.target.value)}>
                  <option value="">Default role</option>
                  {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={loading || !inviteEmail.trim()}>
                  {loading ? <span className="spin" /> : 'Send invitation'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {/* New role modal */}
      {modal === 'role' && (
        <>
          <div className="modal-bg" onClick={() => setModal(null)} />
          <div className="modal modal-lg">
            <h2 className="modal-title">New role</h2>
            {error && <div className="auth-error">{error}</div>}
            <form onSubmit={handleCreateRole}>
              <div className="f2">
                <div className="fgrp">
                  <label className="flbl">Role name</label>
                  <input className="finp" value={roleName} autoFocus required
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRoleName(e.target.value)}
                    placeholder="Senior Account Manager" />
                </div>
                <div className="fgrp">
                  <label className="flbl">Description <span className="fhint">— optional</span></label>
                  <input className="finp" value={roleDesc}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRoleDesc(e.target.value)}
                    placeholder="Manages client projects end-to-end" />
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label className="flbl" style={{ marginBottom: 10 }}>Permissions</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14 }}>
                  {ALL_PERMISSIONS.map(perm => (
                    <label key={perm} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
                      <input type="checkbox" checked={!!rolePerms[perm]}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRolePerms(prev => ({ ...prev, [perm]: e.target.checked }))}
                        style={{ accentColor: 'var(--green)' }} />
                      {perm.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                    </label>
                  ))}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setModal(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={loading || !roleName.trim()}>
                  {loading ? <span className="spin" /> : 'Create role'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {/* Change a member's role — see handleSaveMemberRole above for why
          this had to be built.
          FIX (deep audit, Team & Invites section — mislabeled option):
          this used to offer "No role (default permissions only)" — but
          compute_effective_permissions() (migration 001) and
          update_member_permissions_atomic (migration 055) both resolve a
          null role_id to an EMPTY permission set, not the workspace's
          default role. That fallback ("no role selected → default role")
          only actually happens at invite acceptance
          (accept/signup/route.ts's `member.role_id || defaultRole?.id`),
          which this PATCH path doesn't go through at all. An admin
          picking this option believing it resets someone to baseline
          access would instead silently strip them to whatever their
          permission_overrides alone provide — nothing, for most members.
          Corrected the label to say what actually happens, and added an
          explicit warning when picking it would leave the person with no
          effective permissions at all. */}
      {roleEditMember && (
        <>
          <div className="modal-bg" onClick={() => setRoleEditMember(null)} />
          <div className="modal">
            <h2 className="modal-title">Change role</h2>
            <p className="modal-sub">
              {roleEditMember.users?.name || roleEditMember.users?.email || roleEditMember.invited_email}
              {' '}currently has the {roleEditMember.roles?.name || 'No role'} role.
            </p>
            {error && <div className="auth-error">{error}</div>}
            <div className="fgrp">
              <label className="flbl">Role</label>
              <select className="finp" value={roleEditRoleId}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRoleEditRoleId(e.target.value)}>
                <option value="">No role — removes all role-based permissions</option>
                {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}{r.is_default ? ' (default)' : ''}</option>)}
              </select>
              <span className="fhint">
                You can only assign a role whose permissions you hold yourself. Changing this takes effect
                immediately for that person.
              </span>
              {roleEditRoleId === '' && !Object.values(roleEditMember.permission_overrides || {}).some(v => v === true) && (
                <p className="ferr" style={{ marginTop: 8 }}>
                  This person has no individual permission overrides, so removing their role will leave them
                  with no permissions at all — not the workspace&rsquo;s default role. If you want to reset them
                  to a baseline, assign the actual default role above instead.
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setRoleEditMember(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveMemberRole}
                disabled={loading || roleEditRoleId === (roleEditMember.role_id || '')}>
                {loading ? <span className="spin" /> : 'Save role'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Per-member permission overrides. Tri-state on purpose — see
          handleSaveOverrides above. */}
      {overrideMember && (
        <>
          <div className="modal-bg" onClick={() => setOverrideMember(null)} />
          <div className="modal modal-lg">
            <h2 className="modal-title">
              Permission overrides — {overrideMember.users?.name || overrideMember.users?.email || overrideMember.invited_email}
            </h2>
            <p className="modal-sub">
              Overrides sit on top of the {overrideMember.roles?.name || 'No role'} role for this one person.
              Leave a permission on <strong>Use role</strong> and it keeps following the role, including any
              future changes to it.
            </p>
            {error && <div className="auth-error">{error}</div>}
            <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14, marginBottom: 16 }}>
              {ALL_PERMISSIONS.map(perm => {
                const fromRole = overrideMember.roles?.id
                  ? roles.find((r: any) => r.id === overrideMember.role_id)?.permissions?.[perm] === true
                  : false
                const state = overrideDraft[perm] === undefined ? 'inherit' : (overrideDraft[perm] ? 'grant' : 'revoke')
                return (
                  <div key={perm} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '5px 0' }}>
                    <span style={{ fontSize: 12 }}>
                      {perm.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                      <span style={{ fontSize: 10.5, color: 'var(--text-3)', marginLeft: 6 }}>
                        role: {fromRole ? 'granted' : 'not granted'}
                      </span>
                    </span>
                    <select className="finp" style={{ maxWidth: 140, fontSize: 11.5, padding: '3px 6px' }}
                      value={state}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                        const v = e.target.value
                        setOverrideDraft(prev => {
                          const next = { ...prev }
                          if (v === 'inherit') delete next[perm]
                          else next[perm] = v === 'grant'
                          return next
                        })
                      }}>
                      <option value="inherit">Use role</option>
                      <option value="grant">Always grant</option>
                      <option value="revoke">Always revoke</option>
                    </select>
                  </div>
                )
              })}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setOverrideMember(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveOverrides} disabled={loading}>
                {loading ? <span className="spin" /> : 'Save overrides'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Edit role modal */}
      {editRole && (
        <>
          <div className="modal-bg" onClick={() => setEditRole(null)} />
          <div className="modal modal-lg">
            <h2 className="modal-title">
              Edit role — {editRole.name}
              {editRole.is_default && <span className="pill pill-slate pill-sm" style={{ marginLeft: 8, verticalAlign: 'middle' }}>Default</span>}
            </h2>
            {error && <div className="auth-error">{error}</div>}
            {/* FIX (deep audit, Team & Invites re-pass): name/description
               were editable server-side but had no inputs here — this
               modal only ever touched permissions. */}
            <div className="f2">
              <div className="fgrp">
                <label className="flbl">Role name</label>
                <input className="finp" value={editName} autoFocus
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)} />
              </div>
              <div className="fgrp">
                <label className="flbl">Description <span className="fhint">— optional</span></label>
                <input className="finp" value={editDesc}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditDesc(e.target.value)} />
              </div>
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 16 }}>
              {ALL_PERMISSIONS.map(perm => (
                <label key={perm} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
                  <input type="checkbox" checked={!!editPerms[perm]}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditPerms(p => ({ ...p, [perm]: e.target.checked }))}
                    style={{ accentColor: 'var(--green)' }} />
                  {perm.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                </label>
              ))}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setEditRole(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleEditRole} disabled={loading || !editName.trim()}>
                {loading ? <span className="spin" /> : 'Save changes'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
