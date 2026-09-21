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
  const [linkInvalid, setLinkInvalid] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  // FIX: memoize — creating a fresh client every render (previous version
  // called createClient() directly in the component body) spins up a new
  // GoTrueClient instance on each re-render.
  const [supabase] = useState(() => createClient())

  // FIX 1 (v3): the browser client's detectSessionInUrl (on by default)
  // ALREADY auto-exchanges both the `?code=` query param (PKCE) and the
  // `#access_token=...&type=recovery` hash the moment the client is
  // created — before this effect even runs. The previous version also
  // manually called exchangeCodeForSession(code) here, racing the SDK's own
  // exchange for the exact same single-use code. Whichever lost showed
  // "link expired" even when the SDK's own attempt had already succeeded
  // and a valid session existed. Don't exchange manually — just listen for
  // the result (and fall back to checking for an already-established
  // session, since INITIAL_SESSION fires immediately on subscribe if one
  // exists already).
  useEffect(() => {
    let settled = false
    const markReady = () => {
      settled = true
      // FIX (build — Auth independent audit, LOW): `linkInvalid` used to win over
      // `ready` in the render order and was never cleared, so a slow exchange
      // (> 5 s on a bad connection) showed "link expired" permanently even though
      // the session was established a moment later — with the single-use code
      // already spent.
      setLinkInvalid(false)
      setReady(true)
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        markReady()
      } else if (event === 'INITIAL_SESSION' && session) {
        markReady()
      }
    })

    // A link that Supabase already rejected says so in the URL — show that at
    // once instead of making the person wait out the timeout.
    const query = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    if (query.get('error') || query.get('error_code') || hash.get('error') || hash.get('error_code')) {
      settled = true
      setLinkInvalid(true)
    }

    // Token-hash links (feature gap): when the Supabase "Reset password" email
    // template points at /reset-password?token_hash=…&type=recovery (README §1.3)
    // the link verifies on ANY device. The default PKCE `?code=` link only works
    // in the browser that requested the reset, because the code verifier lives in
    // that browser's cookies.
    const tokenHash = query.get('token_hash')
    if (tokenHash && query.get('type') === 'recovery') {
      settled = true
      supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'recovery' }).then(({ error: otpErr }) => {
        if (otpErr) setLinkInvalid(true)
        else markReady()
        // Never leave a live token in the address bar / history.
        window.history.replaceState({}, '', '/reset-password')
      })
    }

    // Give the SDK's own exchange a moment to finish before giving up.
    const t = setTimeout(() => {
      if (!settled) setLinkInvalid(true)
    }, 5000)

    return () => { clearTimeout(t); subscription.unsubscribe() }
  }, [supabase])

  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) { setError('Passwords do not match.'); return }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    setLoading(true); setError('')
    try {
      // FIX (build — Auth independent audit, MEDIUM): the password used to be set
      // straight from the browser with supabase.auth.updateUser(), followed by a
      // POST to /api/auth/password-changed that proved nothing (any signed-in
      // session could call it to forge audit rows and email the owner). The change
      // is made server-side now; the audit row is written by the database.
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const body = await res.json().catch(() => ({} as { error?: string; code?: string }))
      if (!res.ok) {
        // FIX (deep audit, Auth+MFA re-pass round 3 — infinite redirect loop):
        // this used to treat ANY "two-factor" message as "go pass the
        // challenge" and send everyone to /mfa-challenge. But middleware's
        // must-enroll-mfa gate ALSO says "Two-factor enrollment required..."
        // for someone with a mandatory role who has never enrolled a factor —
        // that regex caught it too. /mfa-challenge has nothing to challenge
        // for such a person (no verified factor exists), so its own effect
        // immediately bounced them straight back to /reset-password, which
        // hit the same 401 again — an infinite loop with no way out except
        // manually navigating to /mfa-setup. middleware now sends a distinct
        // `code` for each case (mfa_challenge_required vs
        // mfa_enrollment_required); route on that instead of pattern-matching
        // the message. `mfa_required` (from THIS route's own 403, a step-up-
        // style check) and the legacy text fallback still mean "go challenge."
        if (body.code === 'mfa_enrollment_required') {
          router.push('/mfa-setup?next=' + encodeURIComponent('/reset-password'))
          return
        }
        if (body.code === 'mfa_required' || body.code === 'mfa_challenge_required' ||
            (res.status === 401 && /two-factor/i.test(body.error || ''))) {
          router.push('/mfa-challenge?next=' + encodeURIComponent('/reset-password'))
          return
        }
        if (body.code === 'no_session' || body.code === 'stale_session') setLinkInvalid(true)
        setError(body.error || 'Could not reset your password.')
        return
      }
      // The server already ended every session; clear this tab's local copy too.
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
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

  if (linkInvalid) {
    return (
      <div className="auth-root">
        <PanelLeft />
        <div className="auth-form-side">
          <div className="auth-form-wrap" style={{ textAlign: 'center' }}>
            <div style={{ width: 52, height: 52, background: 'var(--red-lt)', border: '1px solid #FECACA', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
              <i className="ti ti-link-off" style={{ fontSize: 22, color: 'var(--red)' }} />
            </div>
            <h2 className="auth-form-title" style={{ textAlign: 'center' }}>Reset link expired</h2>
            <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, margin: '8px 0 24px' }}>
              This link is invalid or has already been used. Reset links are single-use — request a new one below.
            </p>
            <Link href="/forgot-password">
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                Request a new link
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
