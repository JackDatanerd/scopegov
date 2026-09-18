// components/team/TeamClient.tsx
// FIX 3C: pending invite table shows invited_email, expiry, + Resend / Revoke buttons
// FIX 3D: invited_email shown first (invitee won't have a users row yet)
// C13: role edit modal (carried forward from previous batch)

'use client'
import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { SessionUser } from '@/lib/supabase/types'
import { initials, avatarColour, formatDate, ALL_PERMISSIONS } from '@/lib/utils/format'

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
  // FIX (deep audit, Team & Invites re-pass): true when the workspace is
  // on Solo (1 seat) but has more than one active member — only reachable
  // if it was downgraded without its seat count being checked first (see
  // /api/billing/upgrade). Lets the page still render instead of locking
  // the workspace out of managing its own over-limit team.
  overSeatLimit?:     boolean
}

export default function TeamClient({ members, pendingInvites, expiredInvites = [], deactivatedMembers = [], roles, session, canInvite, canManageRoles, workspaceId, overSeatLimit }: Props) {
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

  // FIX (deep audit, section 6): this used to PATCH `{ status: 'deactivated' }`
  // to clear the old invite row before resending — but PATCH never handled
  // a `status` field at all, so that call was a silent no-op, and the
  // follow-up POST always 409'd with "an invite is already pending" since
  // the old row was never actually cleared. DELETE already does exactly
  // what "deactivate this pending invite" needs and is fully permission-
  // consistent with the Revoke button right next to Resend — reuse it.
  async function handleResendInvite(m: any) {
    const email = m.invited_email || m.users?.email
    if (!email) return
    setError(''); setNotice('')
    const delRes = await fetch(`/api/team/${m.id}`, { method: 'DELETE' })
    if (!delRes.ok) {
      const j = await delRes.json().catch(() => ({}))
      setError(j.error || 'Could not resend invite'); return
    }
    const res = await fetch('/api/team/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, roleId: m.role_id || null, workspaceId }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) { setError(json.error || 'Could not resend invite'); return }
    if (json.emailFailed) {
      setNotice('Invite recreated, but the email couldn\u2019t be sent. Try Resend again shortly.')
    }
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
          This workspace is on the Solo plan (1 seat) but has {members.length} active members.
          Deactivate members down to 1, or upgrade in Settings &rarr; Billing.
        </div>
      )}
      {error && <div className="auth-error" style={{ marginBottom: 16 }}>{error}</div>}
      {notice && <div className="auth-success" style={{ marginBottom: 16 }}>{notice}</div>}

      <div className="tabbar" style={{ marginBottom: 24 }}>
        <button className={`tabi${tab === 'members' ? ' act' : ''}`} onClick={() => setTab('members')}>
          Members ({members.length + pendingInvites.length})
        </button>
        <button className={`tabi${tab === 'roles' ? ' act' : ''}`} onClick={() => setTab('roles')}>
          Roles ({roles.length})
        </button>
      </div>

      {tab === 'members' && (
        <>
          <div className="member-grid" style={{ marginBottom: 24 }}>
            {members.map((m: any) => {
              const u      = m.users
              const isMe   = u?.id === session.id
              const name   = u?.name || u?.email || 'Unknown'
              const colour = avatarColour(name)
              const isOwner = m.effective_permissions?.MANAGE_WORKSPACE_SETTINGS === true
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
                      {!isMe && canManageRoles && (
                        <button className="btn btn-ghost btn-xs" onClick={() => handleResetMfa(m.id, name)}>
                          Reset MFA
                        </button>
                      )}
                      {!isMe && !isOwner && canInvite && (
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

      {tab === 'roles' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
              {['pro','agency'].includes(session.planTier)
                ? 'Create custom roles for fine-grained access control.'
                : 'Preset roles are available on all plans. Custom roles require Pro or Agency.'}
            </p>
            {canManageRoles && ['pro','agency'].includes(session.planTier) && (
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
