'use client'
import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { safeRedirectPath } from '@/lib/utils/safe-redirect'

function PanelLeft() {
  return (
    <div className="auth-panel">
      <div className="auth-panel-mark">
        <div className="auth-panel-ic"><i className="ti ti-scale" style={{ fontSize: 18, color: '#FFF' }} /></div>
        <span className="auth-panel-name">ScopeGov</span>
      </div>
      <div className="auth-panel-body">
        <h1 className="auth-panel-headline">One more step.</h1>
        <p className="auth-panel-sub">This account requires a second factor to sign in. Enter the code from your authenticator app.</p>
      </div>
    </div>
  )
}

function MfaChallengeInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = safeRedirectPath(searchParams.get('next'))
  const [supabase] = useState(() => createClient())

  const [factorId, setFactorId] = useState<string | null>(null)
  const [loadingFactor, setLoadingFactor] = useState(true)
  const [code, setCode] = useState('')
  const [backupCode, setBackupCode] = useState('')
  const [useBackup, setUseBackup] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data }) => {
      const verified = data?.totp?.find(f => f.status === 'verified')
      setFactorId(verified?.id || null)
      setLoadingFactor(false)
    })
  }, [supabase])

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factorId, code }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Verification failed')
      router.push(next)
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Verification failed')
      setCode('')
    } finally { setLoading(false) }
  }

  async function handleRecover(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/auth/mfa/recover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: backupCode }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Recovery failed')
      // FIX (deep audit, Auth+MFA re-pass): this used to hardcode the
      // redirect with no `next`, unlike handleVerify above — mfa-setup's
      // own "Continue" button (MfaSetupClient.tsx) reads `next` from its
      // query string and falls back to safeRedirectPath(undefined), i.e.
      // '/dashboard', when it's missing. Someone recovering via backup
      // code mid password-reset (arrived here as /mfa-challenge?next=
      // /reset-password) would re-enroll MFA and land on the dashboard,
      // silently abandoning the password reset they started — a page
      // reload could still reach /reset-password manually since the
      // recovery session itself is unaffected, but nothing in the flow
      // told them that. Forward `next` exactly like handleVerify does.
      router.push(`/mfa-setup?recovered=1&next=${encodeURIComponent(next)}`)
      router.refresh()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Recovery failed')
    } finally { setLoading(false) }
  }

  async function handleSignOut() {
    await fetch('/api/auth/signout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <div className="auth-root">
      <PanelLeft />
      <div className="auth-form-side">
        <div className="auth-form-wrap">
          {useBackup ? (
            <>
              <h2 className="auth-form-title">Use a backup code</h2>
              <p className="auth-form-sub">Enter one of the one-time backup codes you saved when you set up two-factor authentication. It will be consumed, and you&apos;ll be asked to set up two-factor authentication again.</p>
              {error && <div className="auth-error">{error}</div>}
              <form onSubmit={handleRecover}>
                <div className="fgrp">
                  <label className="flbl">Backup code</label>
                  <input className="finp" style={{ fontFamily: 'IBM Plex Mono, monospace', letterSpacing: '0.05em' }}
                    placeholder="XXXXX-XXXXX" value={backupCode} autoFocus
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBackupCode(e.target.value.toUpperCase())} required />
                </div>
                <button type="submit" className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                  disabled={loading || !backupCode.trim()}>
                  {loading ? <span className="spin" /> : 'Recover access'}
                </button>
              </form>
              <p className="auth-footer" style={{ marginTop: 20 }}>
                <a className="auth-link" onClick={() => { setUseBackup(false); setError('') }}>Back to authenticator code</a>
              </p>
            </>
          ) : (
            <>
              <h2 className="auth-form-title">Enter your code</h2>
              <p className="auth-form-sub">Open your authenticator app and enter the 6-digit code.</p>
              {error && <div className="auth-error">{error}</div>}
              {loadingFactor ? (
                <div style={{ textAlign: 'center', padding: '20px 0' }}><span className="spin spin-dark" /></div>
              ) : !factorId ? (
                <div className="auth-error">No verified authenticator found on this account. Contact your workspace owner.</div>
              ) : (
                <form onSubmit={handleVerify}>
                  <div className="fgrp">
                    <label className="flbl">6-digit code</label>
                    <input className="finp" style={{ fontFamily: 'IBM Plex Mono, monospace', letterSpacing: '0.3em', textAlign: 'center', fontSize: 20 }}
                      placeholder="000000" value={code} inputMode="numeric" maxLength={6} autoFocus
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value.replace(/\D/g, ''))} required />
                  </div>
                  <button type="submit" className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                    disabled={loading || code.length !== 6}>
                    {loading ? <span className="spin" /> : 'Verify'}
                  </button>
                </form>
              )}
              <p className="auth-footer" style={{ marginTop: 20 }}>
                <a className="auth-link" onClick={() => { setUseBackup(true); setError('') }}>Use a backup code instead</a>
              </p>
            </>
          )}
          <p className="auth-footer" style={{ marginTop: 8 }}>
            <a className="auth-link" onClick={handleSignOut}>Sign out</a>
          </p>
        </div>
      </div>
    </div>
  )
}

export default function MfaChallengePage() {
  return (
    <Suspense fallback={null}>
      <MfaChallengeInner />
    </Suspense>
  )
}
