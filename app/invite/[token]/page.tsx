// app/invite/[token]/page.tsx
// Fix: useEffect now checks json.alreadyAccepted (not just r.status === 404)
// to route into the 'already_used' screen. Previously only a 404 triggered
// that screen — an active-status 200 response fell through to generic 'expired'.

'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { TERMS_VERSION } from '@/lib/auth/terms'
import { validatePassword } from '@/lib/auth/password-policy'

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
  // FIX (deep audit, Team & Invites section — HIGH feature gap): the
  // existing-user screen offered exactly one path — email (disabled) +
  // password + signInWithPassword — on an app whose README (§1.3) lists
  // Google OAuth as a first-class signup route, whose SessionUser carries
  // `hasPasswordIdentity` precisely because password-less accounts exist,
  // and which ships /api/auth/callback to handle them. A Google-only user
  // reaching this screen had no password to type, no Google button to
  // click, and — unlike the 'expired' and 'already_used' screens — not
  // even a "Sign in instead" escape link. It was a hard dead end on a
  // core flow.
  //
  // Two states are now handled that weren't: an already-signed-in visitor
  // (who needs no credentials at all — /accept works off the session they
  // are already carrying), and an OAuth user (who needs to authenticate
  // somewhere other than this form and come straight back).
  const [sessionEmail, setSessionEmail] = useState<string | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)

  useEffect(() => {
    let cancelled = false
    supabase.auth.getUser()
      .then(({ data }: any) => { if (!cancelled) setSessionEmail(data?.user?.email ?? null) })
      .catch(() => { if (!cancelled) setSessionEmail(null) })
      .finally(() => { if (!cancelled) setCheckingSession(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    const passwordProblem = validatePassword(password)
    if (passwordProblem) { setError(passwordProblem); return }
    setLoading(true); setError('')
    try {
      const res  = await fetch(`/api/team/invite/${token}/signup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, password, acceptedTerms: true }),
      })
      const json = await res.json()
      if (!res.ok) {
        // FIX (deep audit, Team & Invites re-pass — dead-end form): the
        // backend (api/team/invite/[token]/signup) already distinguishes
        // three edge cases with dedicated flags — existingAccount (someone
        // signed up independently with this email after the invite was
        // sent but before it was accepted), alreadyMember (a double-submit
        // race with another accept already succeeding), and alreadyUsed
        // (the row is gone). Previously none of these were read here: the
        // error text was shown on this exact same "Create your account"
        // form, which would fail identically forever on retry, with no
        // way to actually get to the sign-in screen it was telling the
        // person to use. Route to the screen that can actually succeed.
        if (json.alreadyUsed) { setMode('already_used'); return }
        if (json.existingAccount || json.alreadyMember) {
          setInvite(prev => prev ? { ...prev, email: json.email || prev.email } : prev)
          setPassword('')
          setError(json.error)
          setMode('existing-user')
          return
        }
        throw new Error(json.error)
      }

      // FIX (deep audit, Team & Invites re-pass): a single fixed 800ms
      // sleep before signing in assumed the newly admin-created Supabase
      // user always propagates within that window. Under any lag past
      // it, the account and workspace membership were already fully
      // created — but signInWithPassword still failed, and the person
      // saw a generic "Something went wrong" with no hint that retrying
      // signup would now correctly reject as "already used" and that
      // they should just sign in instead. Retry the sign-in itself a few
      // times with a short backoff rather than guessing one delay.
      let signInErr: { message: string } | null = null
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 500 * attempt))
        const result = await supabase.auth.signInWithPassword({ email: invite!.email, password })
        signInErr = result.error
        if (!signInErr) break
      }
      if (signInErr) {
        throw new Error('Your account was created — sign in with the password you just set to continue.')
      }

      setMode('done')
      setTimeout(() => router.push('/dashboard'), 1500)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally { setLoading(false) }
  }

  // FIX (deep audit, Settings + Team re-pass round 2 — MEDIUM): POST
  // .../accept returns 403 { code: 'mfa_required' } whenever the signed-in
  // account has an enrolled second factor and the current session is only
  // aal1 (this route sits under the public /api/team/invite/ prefix, so
  // middleware's own aal2 gate — which would normally redirect through
  // /mfa-challenge automatically — never runs for it; see that route's own
  // comment). Neither call site below ever inspected the response body for
  // this, only its `error` string, so an existing user with 2FA landed on a
  // dead end: the button just kept failing with no path forward. The fix is
  // a redirect, not a retry — /mfa-challenge already exists and already
  // understands `next`, exactly like every other aal2-gated flow in the app.
  function redirectIfMfaRequired(status: number, body: any): boolean {
    if (status === 403 && body?.code === 'mfa_required') {
      router.push(`/mfa-challenge?next=${encodeURIComponent(`/invite/${token}`)}`)
      return true
    }
    return false
  }

  // Already signed in as the invited address — there is nothing to
  // authenticate, so just accept. This also covers the OAuth round trip
  // below, which lands back here with a live session.
  async function acceptWithCurrentSession() {
    setLoading(true); setError('')
    try {
      const res = await fetch(`/api/team/invite/${token}/accept`, { method: 'POST' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        if (redirectIfMfaRequired(res.status, j)) return
        throw new Error(j.error || 'Could not accept this invite')
      }
      setMode('done')
      setTimeout(() => router.push('/dashboard'), 1500)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not accept this invite')
    } finally { setLoading(false) }
  }

  // Send the person through Google and bring them straight back to this
  // invite URL, rather than dumping them on /dashboard and leaving them
  // to find the link in their inbox again. `next` is the same mechanism
  // middleware.ts already uses for deep links.
  // `newAccount`: the person is creating their account here (the Terms notice is
  // on screen), so the version they saw is passed on to be recorded.
  async function signInWithGoogle(newAccount = false) {
    setLoading(true); setError('')
    try {
      const terms = newAccount ? `&terms=${encodeURIComponent(TERMS_VERSION)}` : ''
      const { error: oauthErr } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}/api/auth/callback?next=/invite/${token}${terms}` },
      })
      if (oauthErr) throw oauthErr
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not start Google sign-in')
      setLoading(false)
    }
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
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        if (redirectIfMfaRequired(res.status, j)) return
        throw new Error(j.error)
      }
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
    // FIX (deep audit, Team & Invites re-pass — feature gap): this screen
    // used to offer password signup only, with no way in for someone who
    // wants to use Google — a first-class, explicitly supported signup
    // method on the main /signup page. A brand-new invitee who preferred
    // Google had no path here at all short of first tripping the password
    // form and getting bounced. supabase.auth.signInWithOAuth doesn't
    // require an existing account — it creates one — so the same
    // signInWithGoogle/acceptWithCurrentSession pair the existing-user
    // screen already uses works here unchanged; this screen only needed
    // the UI for it and the already-signed-in / mismatched-email checks
    // that go with it.
    const sameEmailSignedIn = !checkingSession && sessionEmail && invite?.email &&
      sessionEmail.toLowerCase() === invite.email.toLowerCase()
    const otherEmailSignedIn = !checkingSession && sessionEmail && invite?.email &&
      sessionEmail.toLowerCase() !== invite.email.toLowerCase()

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

            {sameEmailSignedIn ? (
              // Came back from the Google round trip already signed in as
              // the invited address — nothing left to fill in.
              <div style={{ marginBottom: 20 }}>
                <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 12 }}>
                  You&rsquo;re signed in as <strong>{sessionEmail}</strong>.
                </p>
                <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                  disabled={loading} onClick={acceptWithCurrentSession}>
                  {loading ? <span className="spin" /> : 'Accept invitation'}
                </button>
              </div>
            ) : (
              <>
                {otherEmailSignedIn && (
                  <div className="auth-error" style={{ marginBottom: 16 }}>
                    You&rsquo;re signed in as {sessionEmail}, but this invite was sent to {invite?.email}.
                    Continuing with Google below will use whichever Google account you pick.
                  </div>
                )}
                <button type="button" className="btn btn-ghost"
                  style={{ width: '100%', justifyContent: 'center', padding: '10px', marginBottom: 14 }}
                  disabled={loading} onClick={() => signInWithGoogle(true)}>
                  <i className="ti ti-brand-google" style={{ fontSize: 14 }} /> Continue with Google
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 14px' }}>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  <span style={{ fontSize: 11, color: 'var(--text-3)' }}>or create a password</span>
                  <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                </div>
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
                  <p style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center', marginTop: 12, lineHeight: 1.6 }}>
                    By creating an account you agree to our{' '}
                    <a href="https://scopegov.app/terms" target="_blank" rel="noreferrer" className="auth-link">Terms</a> and{' '}
                    <a href="https://scopegov.app/privacy" target="_blank" rel="noreferrer" className="auth-link">Privacy Policy</a>.
                  </p>
                </form>
              </>
            )}
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

          {/* Already signed in as the invited address — no credentials
              needed at all; /accept works off the existing session. This
              screen used to demand a password from someone who was
              already authenticated. */}
          {!checkingSession && sessionEmail && invite?.email &&
            sessionEmail.toLowerCase() === invite.email.toLowerCase() && (
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, marginBottom: 12 }}>
                You&rsquo;re already signed in as <strong>{sessionEmail}</strong>.
              </p>
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                disabled={loading} onClick={acceptWithCurrentSession}>
                {loading ? <span className="spin" /> : 'Accept invitation'}
              </button>
            </div>
          )}

          {/* Signed in as somebody else — say so explicitly rather than
              letting the password form silently switch accounts. */}
          {!checkingSession && sessionEmail && invite?.email &&
            sessionEmail.toLowerCase() !== invite.email.toLowerCase() && (
            <div className="auth-error" style={{ marginBottom: 16 }}>
              You&rsquo;re signed in as {sessionEmail}, but this invite was sent to {invite.email}.
              Signing in below will switch you to that account.
            </div>
          )}

          {/* The Google path. Without this, an account created through
              Google OAuth had no password to enter and no way forward
              from this screen at all. */}
          <button type="button" className="btn btn-ghost"
            style={{ width: '100%', justifyContent: 'center', padding: '10px', marginBottom: 14 }}
            disabled={loading} onClick={() => signInWithGoogle(false)}>
            <i className="ti ti-brand-google" style={{ fontSize: 14 }} /> Continue with Google
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 14px' }}>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>or use your password</span>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          </div>

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
          {/* The 'expired' and 'already_used' screens both offer a way out
              to /login; this one — the screen people actually get stuck
              on — offered none. */}
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 14, textAlign: 'center' }}>
            Trouble signing in?{' '}
            <Link href={`/login?next=/invite/${token}`} style={{ color: 'var(--green)' }}>
              Sign in another way
            </Link>
            {' '}and we&rsquo;ll bring you back here.
          </p>
        </div>
      </div>
    </div>
  )
}
