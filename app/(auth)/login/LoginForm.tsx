'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

export default function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = searchParams.get('next') || '/dashboard'
  const message = searchParams.get('message')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState('')
  const supabase = createClient()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const { error: err } = await supabase.auth.signInWithPassword({ email, password })
      if (err) { setError(err.message.includes('Invalid') ? 'Incorrect email or password.' : err.message); return }

      // Middleware enforces the MFA gate regardless, but checking here too
      // avoids a flash of the dashboard before being bounced to the
      // challenge screen. getAuthenticatorAssuranceLevel() reads the local
      // session claims — no extra network round trip.
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal?.currentLevel === 'aal1' && aal?.nextLevel === 'aal2') {
        router.push(`/mfa-challenge?next=${encodeURIComponent(next)}`)
        return
      }
      router.push(next); router.refresh()
    } catch { setError('Something went wrong.') } finally { setLoading(false) }
  }

  async function handleGoogle() {
    setGoogleLoading(true); setError('')
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(next)}` },
      })
      if (err) { setError(err.message); setGoogleLoading(false) }
    } catch { setError('Google sign-in failed.'); setGoogleLoading(false) }
  }

  return (
    <div className="auth-root">
      <div className="auth-panel">
        <div className="auth-panel-mark">
          <div className="auth-panel-ic">
            <i className="ti ti-scale" style={{ fontSize: 18, color: '#FFF' }} />
          </div>
          <span className="auth-panel-name">ScopeGov</span>
        </div>
        <div className="auth-panel-body">
          <h1 className="auth-panel-headline">
            Governance over scope.<br />Authority over revenue.
          </h1>
          <p className="auth-panel-sub">
            The platform agencies use to define what&apos;s in scope, enforce it
            with AI, and capture every dollar of billable work clients add
            beyond the agreement.
          </p>
        </div>
        <div className="auth-panel-quote">
          <p className="auth-panel-quote-text">
            &ldquo;We recovered $84,000 in three months from work
            that previously just happened for free.&rdquo;
          </p>
          <p className="auth-panel-quote-by">— Agency Principal, Nairobi</p>
        </div>
      </div>
      <div className="auth-form-side">
        <div className="auth-form-wrap">
          <h2 className="auth-form-title">Sign in</h2>
          <p className="auth-form-sub">Welcome back to your workspace</p>
          {message && <div className="auth-success">{message}</div>}
          {error && <div className="auth-error">{error}</div>}
          <button className="oauth-btn" onClick={handleGoogle} disabled={googleLoading}
            style={{ marginBottom: 16, width: '100%' }}>
            {googleLoading ? <span className="spin spin-dark" /> : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            )}
            Continue with Google
          </button>
          <div className="auth-divider">
            <div className="auth-divider-line" />
            <span className="auth-divider-text">or continue with email</span>
            <div className="auth-divider-line" />
          </div>
          <form onSubmit={handleLogin}>
            <div className="fgrp">
              <label className="flbl">Email address</label>
              <input type="email" className="finp" placeholder="you@agency.com" value={email}
                autoFocus autoComplete="email"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} required />
            </div>
            <div className="fgrp">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <label className="flbl" style={{ margin: 0 }}>Password</label>
                <Link href="/forgot-password" className="auth-link" style={{ fontSize: 11 }}>Forgot?</Link>
              </div>
              <input type="password" className="finp" placeholder="••••••••" value={password}
                autoComplete="current-password"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} required />
            </div>
            <button type="submit" className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '10px 16px', fontSize: 13 }}
              disabled={loading || !email || !password}>
              {loading ? <span className="spin" /> : 'Sign in to workspace'}
            </button>
          </form>
          <p className="auth-footer">
            No account?{' '}
            <Link href="/signup" className="auth-link">Start your 14-day free trial</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
