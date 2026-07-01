'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const supabase = createClient()

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setReady(true)
    })
    return () => subscription.unsubscribe()
  }, [supabase.auth])

  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match.'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setLoading(true); setError('')
    try {
      const { error: err } = await supabase.auth.updateUser({ password })
      if (err) { setError(err.message); return }
      // Spec §16.2: all sessions invalidated on success
      await supabase.auth.signOut()
      setDone(true)
    } catch { setError('Something went wrong.') } finally { setLoading(false) }
  }

  const PanelLeft = () => (
    <div className="auth-panel">
      <div className="auth-panel-mark">
        <div className="auth-panel-ic"><i className="ti ti-scale" style={{ fontSize: 18, color: '#FFF' }} /></div>
        <span className="auth-panel-name">ScopeGov</span>
      </div>
      <div className="auth-panel-body">
        <h1 className="auth-panel-headline">Secure access to your scope records.</h1>
        <p className="auth-panel-sub">Your SOWs, change orders, and Guardian history are protected with bank-level security.</p>
      </div>
    </div>
  )

  if (done) {
    return (
      <div className="auth-root">
        <PanelLeft />
        <div className="auth-form-side">
          <div className="auth-form-wrap" style={{ textAlign: 'center' }}>
            <div style={{ width: 52, height: 52, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
              <i className="ti ti-check" style={{ fontSize: 22, color: 'var(--green)' }} />
            </div>
            <h2 className="auth-form-title" style={{ textAlign: 'center' }}>Password updated</h2>
            <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, margin: '8px 0 24px' }}>
              Your password has been changed and all previous sessions have been signed out.
              Sign in with your new password to continue.
            </p>
            <Link href="/login">
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px' }}>
                Sign in
              </button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="auth-root">
        <PanelLeft />
        <div className="auth-form-side">
          <div className="auth-form-wrap" style={{ textAlign: 'center' }}>
            <span className="spin spin-dark" style={{ width: 24, height: 24 }} />
            <p style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 16 }}>Verifying reset link…</p>
            <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 20 }}>
              Link not working?{' '}
              <Link href="/forgot-password" className="auth-link">Request a new one</Link>
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-root">
      <PanelLeft />
      <div className="auth-form-side">
        <div className="auth-form-wrap">
          <h2 className="auth-form-title">Set new password</h2>
          <p className="auth-form-sub">Choose something strong. You&apos;ll be signed out everywhere else.</p>
          {error && <div className="auth-error">{error}</div>}
          <form onSubmit={handleReset}>
            <div className="fgrp">
              <label className="flbl">New password <span className="fhint">— minimum 8 characters</span></label>
              <input type="password" className="finp" placeholder="Create a strong password" value={password}
                autoFocus autoComplete="new-password" minLength={8}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} required />
            </div>
            <div className="fgrp">
              <label className="flbl">Confirm new password</label>
              <input type="password"
                className={`finp${confirm && confirm !== password ? ' err' : ''}`}
                placeholder="Repeat password" value={confirm} autoComplete="new-password"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirm(e.target.value)} required />
              {confirm && confirm !== password && <p className="ferr">Passwords don&apos;t match.</p>}
            </div>
            <button type="submit" className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '10px', fontSize: 13 }}
              disabled={loading || !password || !confirm || password !== confirm}>
              {loading ? <span className="spin" /> : 'Update password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
