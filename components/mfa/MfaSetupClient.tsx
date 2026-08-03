'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  mandatory: boolean
  next: string
  recovered: boolean
  userName: string
}

type Step = 'loading' | 'scan' | 'backup-codes' | 'already-enrolled' | 'error'

function PanelLeft() {
  return (
    <div className="auth-panel">
      <div className="auth-panel-mark">
        <div className="auth-panel-ic"><i className="ti ti-scale" style={{ fontSize: 18, color: '#FFF' }} /></div>
        <span className="auth-panel-name">ScopeGov</span>
      </div>
      <div className="auth-panel-body">
        <h1 className="auth-panel-headline">Secure your account.</h1>
        <p className="auth-panel-sub">Two-factor authentication is required for your role — it protects the audit trail and portfolio data you have access to.</p>
      </div>
    </div>
  )
}

export default function MfaSetupClient({ mandatory, next, recovered, userName }: Props) {
  const router = useRouter()
  const [step, setStep] = useState<Step>('loading')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [confirmedSaved, setConfirmedSaved] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/auth/mfa/enroll', { method: 'POST' })
      .then(async res => {
        const json = await res.json()
        if (res.status === 409) { setStep('already-enrolled'); return }
        if (!res.ok) throw new Error(json.error || 'Could not start enrollment')
        setFactorId(json.factorId); setQrCode(json.qrCode); setSecret(json.secret)
        setStep('scan')
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not start enrollment')
        setStep('error')
      })
  }, [])

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    if (!factorId || loading) return
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factorId, code }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Verification failed')
      // Never let an empty response (e.g. a login-challenge branch, or a
      // stray retry after codes were already issued) clobber codes we've
      // already received and are showing.
      if (json.backupCodes && json.backupCodes.length > 0) setBackupCodes(json.backupCodes)
      setStep('backup-codes')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Verification failed')
      setCode('')
    } finally { setLoading(false) }
  }

  function handleContinue() {
    router.push(next)
    router.refresh()
  }

  function copyAllCodes() {
    navigator.clipboard.writeText(backupCodes.join('\n')).catch(() => {})
  }

  return (
    <div className="auth-root">
      <PanelLeft />
      <div className="auth-form-side">
        <div className="auth-form-wrap" style={{ maxWidth: step === 'backup-codes' ? 420 : 360 }}>

          {recovered && step === 'scan' && (
            <div className="auth-error" style={{ background: 'var(--amber-lt, #FFFBEB)', borderColor: '#FDE68A', color: '#92400E' }}>
              Your previous authenticator was reset using a backup code. Set up a new one below to keep your account protected.
            </div>
          )}

          {step === 'loading' && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}><span className="spin spin-dark" /></div>
          )}

          {step === 'error' && (
            <>
              <h2 className="auth-form-title">Something went wrong</h2>
              <div className="auth-error">{error}</div>
            </>
          )}

          {step === 'already-enrolled' && (
            <>
              <div style={{ width: 52, height: 52, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                <i className="ti ti-shield-check" style={{ fontSize: 22, color: 'var(--green)' }} />
              </div>
              <h2 className="auth-form-title" style={{ textAlign: 'center' }}>Two-factor authentication is already on</h2>
              <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, margin: '8px 0 24px', textAlign: 'center' }}>
                Your account is already protected. You can manage or reset it from Settings → Account.
              </p>
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px' }} onClick={handleContinue}>
                Continue
              </button>
            </>
          )}

          {step === 'scan' && (
            <>
              <h2 className="auth-form-title">Scan with your authenticator app</h2>
              <p className="auth-form-sub">Use Google Authenticator, 1Password, Authy, or any TOTP app. Hi {userName.split(' ')[0]} — this only takes a minute.</p>
              {error && <div className="auth-error">{error}</div>}

              {qrCode && (
                <div style={{ background: '#FFF', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 16, display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
                  {/* Supabase returns a ready-to-render SVG data URI */}
                  <img src={qrCode} alt="Scan this QR code with your authenticator app" width={180} height={180} />
                </div>
              )}
              {secret && (
                <p style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center', marginBottom: 20, wordBreak: 'break-all' }}>
                  Can&apos;t scan? Enter manually: <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>{secret}</span>
                </p>
              )}

              <form onSubmit={handleVerify}>
                <div className="fgrp">
                  <label className="flbl">Enter the 6-digit code from your app</label>
                  <input className="finp" style={{ fontFamily: 'IBM Plex Mono, monospace', letterSpacing: '0.3em', textAlign: 'center', fontSize: 20 }}
                    placeholder="000000" value={code} inputMode="numeric" maxLength={6} autoFocus
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value.replace(/\D/g, ''))} required />
                </div>
                <button type="submit" className="btn btn-primary"
                  style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                  disabled={loading || code.length !== 6}>
                  {loading ? <span className="spin" /> : 'Verify and enable'}
                </button>
              </form>

              {!mandatory && (
                <p className="auth-footer">
                  <a className="auth-link" onClick={handleContinue}>Skip for now</a>
                </p>
              )}
            </>
          )}

          {step === 'backup-codes' && (
            <>
              <div style={{ width: 52, height: 52, background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                <i className="ti ti-shield-check" style={{ fontSize: 22, color: 'var(--green)' }} />
              </div>
              <h2 className="auth-form-title" style={{ textAlign: 'center' }}>Save your backup codes</h2>
              <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, margin: '8px 0 20px', textAlign: 'center' }}>
                If you lose access to your authenticator app, one of these one-time codes will get you back in.
                <strong> They&apos;re only shown once</strong> — save them somewhere safe now.
              </p>
              {backupCodes.length > 0 ? (
                <>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
                    background: 'var(--bg-2, #F8F8F6)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                    padding: 16, marginBottom: 16, fontFamily: 'IBM Plex Mono, monospace', fontSize: 13,
                  }}>
                    {backupCodes.map((c, i) => <div key={i} style={{ textAlign: 'center', color: 'var(--text)' }}>{c}</div>)}
                  </div>
                  <button className="btn btn-ghost" style={{ width: '100%', justifyContent: 'center', padding: '9px', marginBottom: 16 }} onClick={copyAllCodes}>
                    <i className="ti ti-copy" style={{ marginRight: 6 }} /> Copy all codes
                  </button>
                </>
              ) : (
                <div className="auth-error" style={{ marginBottom: 16 }}>
                  Two-factor authentication is on, but backup codes weren&apos;t shown here. Generate a set from
                  Settings → Account → Two-factor authentication before you rely on this login.
                </div>
              )}
              {backupCodes.length > 0 && (
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--text-2)', marginBottom: 16, cursor: 'pointer' }}>
                  <input type="checkbox" checked={confirmedSaved} style={{ marginTop: 2 }}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmedSaved(e.target.checked)} />
                  I&apos;ve saved these backup codes somewhere safe.
                </label>
              )}
              <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                disabled={backupCodes.length > 0 && !confirmedSaved} onClick={handleContinue}>
                Continue
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
