'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { SessionUser } from '@/lib/supabase/types'
import { initials, avatarColour, formatDate, ALL_PERMISSIONS } from '@/lib/utils/format'

interface Props {
  members:       any[]
  pendingInvites: any[]
  roles:         any[]
  session:       SessionUser
  canInvite:     boolean
  canManageRoles: boolean
  workspaceId:   string
}

export default function TeamClient({ members, pendingInvites, roles, session, canInvite, canManageRoles, workspaceId }: Props) {
  const router  = useRouter()
  const [tab,   setTab]   = useState<'members' | 'roles'>('members')
  const [modal, setModal] = useState<'invite' | 'role' | null>(null)
  const [inviteEmail,  setInviteEmail]  = useState('')
  const [inviteRoleId, setInviteRoleId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [roleName, setRoleName]   = useState('')
  const [roleDesc, setRoleDesc]   = useState('')
  const [rolePerms, setRolePerms] = useState<Record<string, boolean>>({})

  const totalSeats = members.length + pendingInvites.length

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
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send invite')
    } finally { setLoading(false) }
  }

  async function handleDeactivate(memberId: string, memberName: string) {
    if (!confirm(`Deactivate ${memberName}? They will lose workspace access immediately.`)) return
    const res = await fetch(`/api/team/${memberId}`, { method: 'DELETE' })
    if (res.ok) router.refresh()
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

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      {/* Header */}
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

      {/* Tabs */}
      <div className="tabbar" style={{ marginBottom: 24 }}>
        <button className={`tabi${tab === 'members' ? ' act' : ''}`} onClick={() => setTab('members')}>
          Members ({members.length + pendingInvites.length})
        </button>
        <button className={`tabi${tab === 'roles' ? ' act' : ''}`} onClick={() => setTab('roles')}>
          Roles ({roles.length})
        </button>
      </div>

      {/* Members tab */}
      {tab === 'members' && (
        <>
          {/* Active members */}
          <div className="member-grid" style={{ marginBottom: 24 }}>
            {members.map((m: any) => {
              const u         = m.users
              const isMe      = u?.id === session.id
              const name      = u?.name || u?.email || 'Unknown'
              const colour    = avatarColour(name)
              const isOwner   = m.effective_permissions?.MANAGE_WORKSPACE_SETTINGS === true

              return (
                <div key={m.id} className="member-card">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <div className="member-av" style={{ background: colour }}>{initials(name)}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="member-name">{name} {isMe && <span style={{ fontSize: 10, color: 'var(--green)' }}>you</span>}</div>
                      <div className="member-role">{m.roles?.name || 'No role'}</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 12 }}>{u?.email}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      Joined {m.joined_at ? formatDate(m.joined_at) : '—'}
                    </span>
                    {!isMe && !isOwner && canInvite && (
                      <button className="btn btn-ghost btn-xs"
                        style={{ color: 'var(--red)', borderColor: '#FECACA' }}
                        onClick={() => handleDeactivate(m.id, name)}>
                        Deactivate
                      </button>
                    )}
                  </div>
                </div>
              )
            })}

            {/* Invite slot */}
            {canInvite && (
              <div className="invite-slot" onClick={() => setModal('invite')}>
                <i className="ti ti-user-plus" style={{ fontSize: 28, color: 'var(--green)', marginBottom: 10 }} />
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--green)' }}>Invite member</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>Send an invitation by email</span>
              </div>
            )}
          </div>

          {/* Pending invites */}
          {pendingInvites.length > 0 && (
            <div>
              <div className="sec-hd"><div className="sec-title">Pending invitations ({pendingInvites.length})</div></div>
              <div className="surface" style={{ overflow: 'hidden' }}>
                <table className="gov-table" style={{ width: '100%' }}>
                  <thead><tr><th>Email</th><th>Role</th><th>Invited</th><th>Expires</th><th /></tr></thead>
                  <tbody>
                    {pendingInvites.map((m: any) => (
                      <tr key={m.id}>
                        <td className="td-primary">{m.users?.email || '—'}</td>
                        <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{m.roles?.name || 'Default'}</td>
                        <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatDate(m.invited_at)}</td>
                        <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatDate(m.invite_token_expires_at)}</td>
                        <td>
                          <span className="pill pill-amber pill-sm">Pending</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Roles tab */}
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
                  <th>Role name</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'center' }}>Members</th>
                  <th style={{ textAlign: 'center' }}>Permissions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {roles.map((r: any) => {
                  const memberCount  = members.filter((m: any) => m.role_id === r.id).length
                  const permCount    = Object.values(r.permissions || {}).filter(Boolean).length
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="td-primary">{r.name}</div>
                        {r.is_default && <span className="pill pill-slate pill-sm" style={{ marginTop: 3 }}>Default</span>}
                      </td>
                      <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{r.description || '—'}</td>
                      <td style={{ textAlign: 'center', fontFamily: 'Cormorant Garamond, Georgia, serif', fontSize: 18 }}>{memberCount}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span className="pill pill-green pill-sm">{permCount} / 24</span>
                      </td>
                      <td>
                        {!r.is_default && canManageRoles && (
                          <button className="btn-icon">
                            <i className="ti ti-pencil" style={{ fontSize: 13 }} />
                          </button>
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
                <label className="flbl">Role <span className="fhint">— optional, assigns on acceptance</span></label>
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
            <p className="modal-sub">Define a custom permission set for this workspace.</p>
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
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setRolePerms(prev => ({ ...prev, [perm]: e.target.checked }))}
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
    </div>
  )
}
