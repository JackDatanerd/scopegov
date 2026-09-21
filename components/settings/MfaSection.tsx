// components/settings/MfaSection.tsx
'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { fetchWithStepUp } from '@/lib/client/step-up'

interface Status {
  enrolled: boolean
  factorId: string | null
  enrolledAt: string | null
  unusedBackupCodes: number
}

export default function MfaSection({ mandatory }: { mandatory: boolean }) {
  const router = useRouter()
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirmingDisable, setConfirmingDisable] = useState(false)
  const [newCodes, setNewCodes] = useState<string[] | null>(null)
  const [error, setError] = useState('')

  function loadStatus() {
    fetch('/api/auth/mfa/factors').then(r => r.json()).then(setStatus).catch(() => {})
  }
  useEffect(loadStatus, [])

  async function handleDisable() {
    if (!status?.factorId) return
    setLoading(true); setError('')
    try {
      const res = await fetchWithStepUp('/api/auth/mfa/factors', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factorId: status.factorId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setConfirmingDisable(false)
      loadStatus()
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Could not disable') } finally { setLoading(false) }
  }

  async function handleRegenerate() {
    setLoading(true); setError('')
    try {
      const res = await fetchWithStepUp('/api/auth/mfa/backup-codes', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setNewCodes(json.backupCodes)
      loadStatus()
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Could not regenerate codes') } finally { setLoading(false) }
  }

  function copyAllCodes() {
    if (newCodes) navigator.clipboard.writeText(newCodes.join('\n')).catch(() => {})
  }

  if (!status) {
    return (
      <div className="settings-section">
        <div className="settings-section-title">Two-factor authentication</div>
        <div style={{ padding: '8px 0' }}><span className="spin spin-dark" /></div>
      </div>
    )
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        Two-factor authentication
        {status.enrolled ? (
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: 'var(--green-lt)', color: 'var(--green)' }}>Enabled</span>
        ) : mandatory ? (
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: 'var(--red-lt)', color: 'var(--red)' }}>Required, not set up</span>
        ) : (
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20, background: 'var(--bg-2, #F0F0EC)', color: 'var(--text-3)' }}>Off</span>
        )}
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}

      {!status.enrolled && (
        <>
          <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, margin: '0 0 14px' }}>
            {mandatory
              ? 'Your role requires an authenticator app to sign in. Set it up now.'
              : 'Add an authenticator app as a second sign-in step for extra protection on your account.'}
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => router.push('/mfa-setup?next=%2Fsettings%3Ftab%3Daccount')}>
            Set up two-factor authentication
          </button>
        </>
      )}

      {status.enrolled && (
        <>
          <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, margin: '0 0 14px' }}>
            An authenticator app is required to sign in to your account.
            {status.enrolledAt && ` Enabled on ${new Date(status.enrolledAt).toLocaleDateString()}.`}
          </p>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: 'var(--bg-2, #F8F8F6)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>Backup codes</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{status.unusedBackupCodes} unused code{status.unusedBackupCodes === 1 ? '' : 's'} remaining</div>
            </div>
            <button className="btn btn-ghost btn-sm" disabled={loading} onClick={handleRegenerate}>
              {loading ? <span className="spin" /> : 'Regenerate'}
            </button>
          </div>

          {newCodes && (
            <div className="settings-section" style={{ background: 'var(--bg-2, #F8F8F6)', marginBottom: 14 }}>
              <div className="settings-section-title">New backup codes — save these now</div>
              <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 12px' }}>Your previous codes no longer work. These are shown once.</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, marginBottom: 12 }}>
                {newCodes.map((c, i) => <div key={i} style={{ textAlign: 'center' }}>{c}</div>)}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={copyAllCodes}>Copy all</button>
                <button className="btn btn-primary btn-sm" onClick={() => setNewCodes(null)}>Done</button>
              </div>
            </div>
          )}

          {!confirmingDisable ? (
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }}
              disabled={mandatory} title={mandatory ? 'Your role requires two-factor authentication' : undefined}
              onClick={() => setConfirmingDisable(true)}>
              Disable two-factor authentication
            </button>
          ) : (
            <div style={{ padding: '12px 14px', background: 'var(--red-lt)', border: '1px solid #FECACA', borderRadius: 'var(--radius-sm)' }}>
              <p style={{ fontSize: 13, color: 'var(--text)', margin: '0 0 10px' }}>
                Disable two-factor authentication? Your account will only require a password to sign in.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger btn-sm" disabled={loading} onClick={handleDisable}>
                  {loading ? <span className="spin" /> : 'Yes, disable'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmingDisable(false)}>Cancel</button>
              </div>
            </div>
          )}
          {mandatory && !confirmingDisable && (
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>Your role requires two-factor authentication — it can&apos;t be turned off here.</p>
          )}
        </>
      )}
    </div>
  )
}
