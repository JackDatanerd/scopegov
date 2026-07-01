'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      // Spec §16.2: same response regardless of whether email exists
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      setSent(true)
    } catch { setError('Something went wrong. Please try again.') } finally { setLoading(false) }
  }

  return (
    <div className="auth-root">
      <div className="auth-panel">
        <div className="auth-panel-mark">
          <div className="auth-panel-ic"><i className="ti ti-scale" style={{ fontSize: 18, color: '#FFF' }} /></div>
          <span className="auth-panel-name">ScopeGov</span>
        </div>
        <div className="auth-panel-body">
          <h1 className="auth-panel-headline">Password recovery is quick and secure.</h1>
          <p className="auth-panel-sub">Reset your password and get back to governing your scope in under two minutes.</p>
        </div>
      </div>
      <div className="auth-form-side">
        <div className="auth-form-wrap">
          {sent ? (
            <>
              <div style={{ width: 52, height: 52, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20 }}>
                <i className="ti ti-mail" style={{ fontSize: 22, color: 'var(--green)' }} />
              </div>
              <h2 className="auth-form-title">Check your inbox</h2>
              <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, margin: '8px 0 24px' }}>
                If an account exists for <strong>{email}</strong>, you&apos;ll receive a reset
                link within a few minutes.
              </p>
              <Link href="/login">
                <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center' }}>
                  ← Back to sign in
                </button>
              </Link>
            </>
          ) : (
            <>
              <h2 className="auth-form-title">Reset your password</h2>
              <p className="auth-form-sub">Enter your email and we&apos;ll send a secure reset link.</p>
              {error && <div className="auth-error">{error}</div>}
              <form onSubmit={handleSubmit}>
                <div className="fgrp">
                  <label className="flbl">Email address</label>
                  <input type="email" className="finp" placeholder="you@agency.com" value={email} autoFocus
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} required />
                </div>
                <button type="submit" className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center', padding: '10px', fontSize: 13 }}
                  disabled={loading || !email}>
                  {loading ? <span className="spin" /> : 'Send reset link'}
                </button>
              </form>
              <p className="auth-footer">
                <Link href="/login" className="auth-link">← Back to sign in</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
