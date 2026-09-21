'use client'

// Settings → Account → Sessions. Lists where the account is signed in (device, IP,
// last activity — from auth.sessions via /api/auth/sessions), lets the person end
// any one they don't recognise, or all of the others at once.

import { useCallback, useEffect, useState } from 'react'

interface SessionRow {
  id: string
  device: string
  ip: string | null
  createdAt: string
  lastActiveAt: string
  mfa: boolean
  current: boolean
}

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

export default function SessionsSection() {
  const [rows, setRows] = useState<SessionRow[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [busyAll, setBusyAll] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/sessions')
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not load sessions')
      setRows(json.sessions as SessionRow[])
    } catch (e: any) { setErr(e.message || 'Could not load sessions'); setRows([]) }
  }, [])
  useEffect(() => { load() }, [load])

  async function revokeOne(id: string) {
    setBusyId(id); setErr(''); setMsg('')
    try {
      const res = await fetch(`/api/auth/sessions/${id}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not sign that session out')
      setMsg('Session signed out.')
      await load()
    } catch (e: any) { setErr(e.message) } finally { setBusyId(null) }
  }

  async function revokeOthers() {
    setBusyAll(true); setErr(''); setMsg('')
    try {
      const res = await fetch('/api/auth/signout-others', { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Failed to sign out other sessions')
      setMsg('Signed out of all other sessions. This device stays signed in.')
      await load()
    } catch (e: any) { setErr(e.message) } finally { setBusyAll(false) }
  }

  const others = (rows || []).filter(r => !r.current)

  return (
    <div className="settings-section">
      <div className="settings-section-title">Sessions</div>
      <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
        Where your account is signed in right now. If you don&apos;t recognise one, sign it out and change your password.
      </p>
      {msg && <div className="auth-success" style={{ marginBottom: 12 }}>{msg}</div>}
      {err && <div className="auth-error" style={{ marginBottom: 12 }}>{err}</div>}
      {rows === null ? (
        <div style={{ padding: '8px 0' }}><span className="spin spin-dark" /></div>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
          {rows.map(r => (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--text)' }}>
                  {r.device}{r.current && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--green)' }}>This device</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                  {r.ip || 'IP unknown'} · active {ago(r.lastActiveAt)} · signed in {ago(r.createdAt)}
                  {r.mfa ? ' · 2-step verified' : ''}
                </div>
              </div>
              {!r.current && (
                <button type="button" className="btn btn-ghost btn-xs" disabled={busyId === r.id} onClick={() => revokeOne(r.id)}>
                  {busyId === r.id ? <span className="spin spin-dark" /> : 'Sign out'}
                </button>
              )}
            </div>
          ))}
          {rows.length === 0 && !err && <div style={{ fontSize: 13, color: 'var(--text-3)' }}>No other information available.</div>}
        </div>
      )}
      <button type="button" className="btn btn-secondary btn-sm" disabled={busyAll || others.length === 0} onClick={revokeOthers}>
        {busyAll ? <span className="spin" /> : 'Sign out of all other sessions'}
      </button>
    </div>
  )
}
