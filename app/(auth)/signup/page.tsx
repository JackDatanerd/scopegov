'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import { TERMS_VERSION } from '@/lib/auth/terms'

export default function SignupPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState('')
  const [emailSent, setEmailSent] = useState(false)
  // Resend of the verification email (feature gap): the "check your email" screen
  // only offered "try a different address", so a lost/never-arrived link was a
  // dead end.
  const [resendCooldown, setResendCooldown] = useState(0)
  const [resendNotice, setResendNotice] = useState('')
  const supabase = createClient()

  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setTimeout(() => setResendCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCooldown])

  async function handleResend() {
    if (!email || resendCooldown > 0) return
    setResendNotice('')
    await supabase.auth.resend({
      type: 'signup', email,
      options: { emailRedirectTo: `${window.location.origin}/api/auth/callback?next=/onboarding` },
    }).catch(() => {})
    setResendCooldown(60)
    setResendNotice('A new verification link is on its way.')
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setLoading(true); setError('')
    try {
      // FIX (deep audit, Auth+MFA re-pass — signup password-policy
      // bypass): this used to call supabase.auth.signUp() directly from
      // the browser, with only this page's own bare length>=8 check (and,
      // briefly, an advisory /api/auth/validate-password pre-check)
      // standing between a request and account creation — neither stopped
      // a direct supabase.auth.signUp() call (trivial with the public
      // anon key) from skipping the common-password blocklist, the
      // email-match check, and the 72-byte bcrypt cap that every OTHER
      // password-setting route in this app enforces (change-password,
      // reset-password, invite-signup). Account creation itself now runs
      // server-side via /api/auth/signup, which calls validatePassword()
      // authoritatively before touching supabase.auth.signUp() — the same
      // pattern those other routes already use. See that route for the
      // terms_version/emailRedirectTo/enumeration-safety details, all
      // unchanged from before.
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      })
      const json = await res.json().catch(() => ({ error: 'Something went wrong. Please try again.' }))
      if (!res.ok || json.error) { setError(json.error || 'Something went wrong. Please try again.'); return }
      // Full navigation (not router.push) on the rare path where email
      // confirmation is disabled and a session already exists: the session
      // was just established server-side via Set-Cookie on this response,
      // and a hard navigation is what gets this page's own in-browser
      // supabase client to pick it up, the same way it would after any
      // other server-set session.
      if (!json.emailSent) { window.location.href = '/onboarding' }
      else { setEmailSent(true) }
    } catch { setError('Something went wrong. Please try again.') } finally { setLoading(false) }
  }

  async function handleGoogle() {
    setGoogleLoading(true); setError('')
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        // `terms` = the version shown on this page; /api/auth/callback records it.
        options: { redirectTo: `${window.location.origin}/api/auth/callback?next=/onboarding&terms=${encodeURIComponent(TERMS_VERSION)}` },
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
              Didn&apos;t receive it? Check spam,{' '}
              <button onClick={handleResend} disabled={resendCooldown > 0}
                style={{ background: 'none', border: 'none', color: 'var(--green)', cursor: resendCooldown > 0 ? 'default' : 'pointer', fontSize: 12, fontFamily: 'inherit', fontWeight: 500 }}>
                {resendCooldown > 0 ? `resend the email (${resendCooldown}s)` : 'resend the email'}
              </button>
              {' '}or{' '}
              <button onClick={() => setEmailSent(false)}
                style={{ background: 'none', border: 'none', color: 'var(--green)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', fontWeight: 500 }}>
                try a different email address
              </button>.
            </p>
            {resendNotice && <p style={{ fontSize: 12, color: 'var(--green)', marginTop: 10 }}>{resendNotice}</p>}
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
              <input className="finp" placeholder="Jane Mwangi" value={name} autoFocus autoComplete="name" maxLength={120}
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
