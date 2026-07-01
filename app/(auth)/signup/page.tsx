'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function SignupPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState('')
  const [emailSent, setEmailSent] = useState(false)
  const supabase = createClient()

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setLoading(true); setError('')
    try {
      const { data, error: err } = await supabase.auth.signUp({
        email, password,
        options: {
          data: { name },
          emailRedirectTo: `${window.location.origin}/api/auth/callback?next=/onboarding`,
        },
      })
      if (err) {
        setError(err.message.toLowerCase().includes('already registered')
          ? 'An account with this email already exists. Sign in instead.'
          : err.message)
        return
      }
      if (data.session) { router.push('/onboarding') }
      else { setEmailSent(true) }
    } catch { setError('Something went wrong. Please try again.') } finally { setLoading(false) }
  }

  async function handleGoogle() {
    setGoogleLoading(true); setError('')
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/api/auth/callback?next=/onboarding` },
      })
      if (err) { setError(err.message); setGoogleLoading(false) }
    } catch { setError('Google sign-up failed.'); setGoogleLoading(false) }
  }

  if (emailSent) {
    return (
      <div className="auth-root">
        <div className="auth-panel">
          <div className="auth-panel-mark">
            <div className="auth-panel-ic"><i className="ti ti-scale" style={{ fontSize: 18, color: '#FFF' }} /></div>
            <span className="auth-panel-name">ScopeGov</span>
          </div>
          <div className="auth-panel-body">
            <h1 className="auth-panel-headline">You&apos;re one step away.</h1>
            <p className="auth-panel-sub">Verify your email to activate your workspace and start governing your scope.</p>
          </div>
          <div className="auth-panel-quote">
            <p className="auth-panel-quote-text">&ldquo;The first signed SOW is always the best moment — knowing exactly what you agreed to, in writing.&rdquo;</p>
            <p className="auth-panel-quote-by">— Design Studio, Lagos</p>
          </div>
        </div>
        <div className="auth-form-side">
          <div className="auth-form-wrap" style={{ textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
              <i className="ti ti-mail-check" style={{ fontSize: 24, color: 'var(--green)' }} />
            </div>
            <h2 className="auth-form-title" style={{ textAlign: 'center' }}>Check your email</h2>
            <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, margin: '8px 0 24px' }}>
              We sent a verification link to <strong>{email}</strong>.
              Click it to activate your account and get started.
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.6 }}>
              Didn&apos;t receive it? Check spam, or{' '}
              <button onClick={() => setEmailSent(false)}
                style={{ background: 'none', border: 'none', color: 'var(--green)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', fontWeight: 500 }}>
                try a different email address
              </button>.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-root">
      <div className="auth-panel">
        <div className="auth-panel-mark">
          <div className="auth-panel-ic"><i className="ti ti-scale" style={{ fontSize: 18, color: '#FFF' }} /></div>
          <span className="auth-panel-name">ScopeGov</span>
        </div>
        <div className="auth-panel-body">
          <h1 className="auth-panel-headline">Put governance at the centre of every client engagement.</h1>
          <p className="auth-panel-sub">
            AI-powered scope monitoring. Automated change orders. Signed SOWs
            that actually protect you. 14 days free, no card required.
          </p>
        </div>
        <div className="auth-panel-quote">
          <p className="auth-panel-quote-text">&ldquo;The Guardian feature alone paid for the platform twelve times over in the first quarter.&rdquo;</p>
          <p className="auth-panel-quote-by">— Creative Director, Johannesburg</p>
        </div>
      </div>
      <div className="auth-form-side">
        <div className="auth-form-wrap">
          <h2 className="auth-form-title">Create your account</h2>
          <p className="auth-form-sub">14-day free trial · No credit card required</p>
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
            Sign up with Google
          </button>
          <div className="auth-divider">
            <div className="auth-divider-line" />
            <span className="auth-divider-text">or with email</span>
            <div className="auth-divider-line" />
          </div>
          <form onSubmit={handleSignup}>
            <div className="fgrp">
              <label className="flbl">Your name</label>
              <input className="finp" placeholder="Jane Mwangi" value={name} autoFocus autoComplete="name"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} required />
            </div>
            <div className="fgrp">
              <label className="flbl">Work email</label>
              <input type="email" className="finp" placeholder="jane@youragency.com" value={email} autoComplete="email"
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} required />
            </div>
            <div className="fgrp">
              <label className="flbl">Password <span className="fhint">— 8 characters minimum</span></label>
              <input type="password" className="finp" placeholder="Create a strong password" value={password}
                autoComplete="new-password" minLength={8}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} required />
            </div>
            <button type="submit" className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '10px 16px', fontSize: 13 }}
              disabled={loading || !name || !email || !password}>
              {loading ? <span className="spin" /> : 'Create account — it\'s free'}
            </button>
          </form>
          <p className="auth-footer">
            Already have an account?{' '}
            <Link href="/login" className="auth-link">Sign in</Link>
          </p>
          <p style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center', marginTop: 14, lineHeight: 1.6 }}>
            By signing up you agree to our{' '}
            <a href="https://scopegov.app/terms" target="_blank" className="auth-link">Terms</a> and{' '}
            <a href="https://scopegov.app/privacy" target="_blank" className="auth-link">Privacy Policy</a>.
          </p>
        </div>
      </div>
    </div>
  )
}
