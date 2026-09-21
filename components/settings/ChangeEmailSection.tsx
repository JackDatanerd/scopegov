'use client'

// Settings → Account → Sign-in email. Starts the guarded change (POST
// /api/auth/change-email): needs a recent password / authenticator confirmation,
// and nothing changes until the confirmation link(s) are followed.

import { useState } from 'react'
import { fetchWithStepUp } from '@/lib/client/step-up'

export default function ChangeEmailSection({ currentEmail }: { currentEmail: string }) {
  const [newEmail, setNewEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg(''); setErr('')
    try {
      const res = await fetchWithStepUp('/api/auth/change-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newEmail }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not start the email change')
      setMsg('Check your inbox: we sent a confirmation link to the new address (and to your current one). Your sign-in email changes once it is confirmed.')
      setNewEmail('')
    } catch (e2: any) { setErr(e2.message) } finally { setBusy(false) }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title">Sign-in email</div>
      <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
        You sign in as <strong>{currentEmail}</strong>. Changing it needs a confirmation from your inbox.
      </p>
      {msg && <div className="auth-success" style={{ marginBottom: 12 }}>{msg}</div>}
      {err && <div className="auth-error" style={{ marginBottom: 12 }}>{err}</div>}
      <form onSubmit={submit}>
        <div className="fgrp">
          <label className="flbl">New email address</label>
          <input className="finp" type="email" required value={newEmail} maxLength={254}
            autoComplete="email" placeholder="you@newaddress.com"
            onChange={ev => setNewEmail(ev.target.value)} />
        </div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !newEmail}>
          {busy ? <span className="spin" /> : 'Send confirmation'}
        </button>
      </form>
    </div>
  )
}
