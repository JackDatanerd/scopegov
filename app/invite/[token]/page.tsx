// app/invite/[token]/page.tsx
// Fix: useEffect now checks json.alreadyAccepted (not just r.status === 404)
// to route into the 'already_used' screen. Previously only a 404 triggered
// that screen — an active-status 200 response fell through to generic 'expired'.

'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'

export default function InvitePage() {
  const router   = useRouter()
  const params   = useParams()
  const token    = params.token as string
  const supabase = createClient()

  const [invite,   setInvite]   = useState<{ email: string; workspaceName: string; agencyName: string; inviterName: string } | null>(null)
  const [mode,     setMode]     = useState<'loading' | 'expired' | 'already_used' | 'new-user' | 'existing-user' | 'done'>('loading')
  const [name,     setName]     = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  useEffect(() => {
    fetch(`/api/team/invite/${token}`)
      .then(async r => {
        const json = await r.json()

        // Fix: check alreadyAccepted flag OR 404 — not just 404.
        // A cleared invite_token (status === 'active') returns 200 with
        // alreadyAccepted: true, which previously fell through to 'expired'.
        if (r.status === 404 || json.alreadyAccepted) {
          setMode('already_used')
          return
        }
        if (!r.ok || json.expired) { setMode('expired'); return }

        setInvite(json.invite)
        setMode(json.hasAccount ? 'existing-user' : 'new-user')
      })
      .catch(() => setMode('expired'))
  }, [token])

  async function handleNewUser(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setLoading(true); setError('')
    try {
      const res  = await fetch(`/api/team/invite/${token}/signup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, password }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)

      // Wait for Supabase to propagate the newly admin-created user
      await new Promise(resolve => setTimeout(resolve, 800))

      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: invite!.email,
        password,
      })
      if (signInErr) throw new Error(signInErr.message)

      setMode('done')
      setTimeout(() => router.push('/dashboard'), 1500)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setLoading(false) }
  }

  async function handleExistingUser(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: invite!.email, password,
      })
      if (signInErr) throw signInErr
      const res = await fetch(`/api/team/invite/${token}/accept`, { method: 'POST' })
      if (!res.ok) { const j = await res.json(); throw new Error(j.error) }
      setMode('done')
      setTimeout(() => router.push('/dashboard'), 1500)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Incorrect password or invite already used')
    } finally { setLoading(false) }
  }

  const PanelLeft = () => (
    <div className="auth-panel">
      <div className="auth-panel-mark">
        <div className="auth-panel-ic"><i className="ti ti-scale" style={{ fontSize: 18, color: '#FFF' }} /></div>
        <span className="auth-panel-name">ScopeGov</span>
      </div>
      <div className="auth-panel-body">
        <h1 className="auth-panel-headline">You&apos;ve been invited to govern scope together.</h1>
        <p className="auth-panel-sub">
          {invite
            ? `${invite.agencyName} uses ScopeGov to manage project scope, change orders, and client agreements.`
            : 'ScopeGov helps agencies define, protect, and capture every billable scope element.'}
        </p>
      </div>
    </div>
  )

  if (mode === 'loading') {
    return (
      <div className="auth-root"><PanelLeft />
        <div className="auth-form-side">
          <div className="auth-form-wrap" style={{ textAlign: 'center' }}>
            <span className="spin spin-dark" style={{ width: 24, height: 24 }} />
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 16 }}>Validating your invite…</p>
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'expired') {
    return (
      <div className="auth-root"><PanelLeft />
        <div className="auth-form-side">
          <div className="auth-form-wrap">
            <div style={{ width: 52, height: 52, background: 'var(--red-lt)', border: '1px solid #FECACA', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
              <i className="ti ti-link-off" style={{ fontSize: 22, color: 'var(--red)' }} />
            </div>
            <h2 className="auth-form-title">Invite link expired</h2>
            <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, margin: '8px 0 24px' }}>
              This invite link has expired or is no longer valid. Ask the workspace owner to send a fresh invitation.
            </p>
            <Link href="/login"><button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}>Sign in instead</button></Link>
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'already_used') {
    return (
      <div className="auth-root"><PanelLeft />
        <div className="auth-form-side">
          <div className="auth-form-wrap">
            <div style={{ width: 52, height: 52, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
              <i className="ti ti-check" style={{ fontSize: 22, color: 'var(--green)' }} />
            </div>
            <h2 className="auth-form-title">Invite link already used</h2>
            <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 24 }}>
              This invite link has already been accepted. If you signed up already, sign in below to access your workspace.
            </p>
            <Link href="/login">
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                Sign in to ScopeGov
              </button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'done') {
    return (
      <div className="auth-root"><PanelLeft />
        <div className="auth-form-side">
          <div className="auth-form-wrap" style={{ textAlign: 'center' }}>
            <div style={{ width: 52, height: 52, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
              <i className="ti ti-check" style={{ fontSize: 22, color: 'var(--green)' }} />
            </div>
            <h2 className="auth-form-title">You&apos;re in</h2>
            <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7 }}>
              Welcome to <strong>{invite?.workspaceName}</strong>. Taking you to the dashboard…
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'new-user') {
    return (
      <div className="auth-root"><PanelLeft />
        <div className="auth-form-side">
          <div className="auth-form-wrap">
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: 'var(--radius-sm)', padding: '5px 11px', marginBottom: 20 }}>
              <i className="ti ti-building" style={{ fontSize: 12, color: 'var(--green)' }} />
              <span style={{ fontSize: 12, color: 'var(--green)', fontWeight: 500 }}>{invite?.agencyName} · {invite?.workspaceName}</span>
            </div>
            <h2 className="auth-form-title">Create your account</h2>
            <p className="auth-form-sub">Invited by {invite?.inviterName} to join {invite?.workspaceName}. Your email is pre-verified.</p>
            {error && <div className="auth-error">{error}</div>}
            <form onSubmit={handleNewUser}>
              <div className="fgrp">
                <label className="flbl">Email</label>
                <input className="finp" value={invite?.email || ''} disabled />
              </div>
              <div className="fgrp">
                <label className="flbl">Your name</label>
                <input className="finp" value={name} autoFocus placeholder="Jane Mwangi"
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} required />
              </div>
              <div className="fgrp">
                <label className="flbl">Create password <span className="fhint">— 8 characters minimum</span></label>
                <input type="password" className="finp" placeholder="Choose a strong password" value={password}
                  autoComplete="new-password" minLength={8}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} required />
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                disabled={loading || !name || !password}>
                {loading ? <span className="spin" /> : 'Accept invitation'}
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-root"><PanelLeft />
      <div className="auth-form-side">
        <div className="auth-form-wrap">
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: 'var(--radius-sm)', padding: '5px 11px', marginBottom: 20 }}>
            <i className="ti ti-building" style={{ fontSize: 12, color: 'var(--green)' }} />
            <span style={{ fontSize: 12, color: 'var(--green)', fontWeight: 500 }}>{invite?.agencyName} · {invite?.workspaceName}</span>
          </div>
          <h2 className="auth-form-title">Join {invite?.workspaceName}</h2>
          <p className="auth-form-sub">You already have a ScopeGov account. Sign in to accept the invitation from {invite?.inviterName}.</p>
          {error && <div className="auth-error">{error}</div>}
          <form onSubmit={handleExistingUser}>
            <div className="fgrp">
              <label className="flbl">Email</label>
              <input className="finp" value={invite?.email || ''} disabled />
            </div>
            <div className="fgrp">
              <label className="flbl">Password</label>
              <input type="password" className="finp" placeholder="Your ScopeGov password" value={password} autoFocus
                autoComplete="current-password"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} required />
            </div>
            <button type="submit" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
              disabled={loading || !password}>
              {loading ? <span className="spin" /> : 'Sign in & accept invitation'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
