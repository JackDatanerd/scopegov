'use client'

// Modal that answers lib/client/step-up.ts: "Confirm it's you" with an authenticator
// code (accounts with MFA) or the account password. Mounted once in the app layout.

import { useEffect, useRef, useState } from 'react'
import { STEP_UP_EVENT, STEP_UP_HOST_FLAG, type StepUpRequestDetail, type StepUpMethod } from '@/lib/client/step-up'

export default function StepUpHost() {
  const [open, setOpen] = useState(false)
  const [method, setMethod] = useState<StepUpMethod>('password')
  const [value, setValue] = useState('')
  const [factorId, setFactorId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  useEffect(() => {
    ;(window as any)[STEP_UP_HOST_FLAG] = true
    async function onRequest(e: Event) {
      const { methods, resolve } = (e as CustomEvent<StepUpRequestDetail>).detail
      resolver.current?.(false)            // a newer request supersedes an unanswered one
      resolver.current = resolve
      const m: StepUpMethod = methods.includes('totp') ? 'totp' : 'password'
      setMethod(m); setValue(''); setError(''); setFactorId(null); setOpen(true)
      if (m === 'totp') {
        try {
          const r = await fetch('/api/auth/mfa/factors'); const j = await r.json()
          setFactorId(j.factorId || null)
        } catch { /* the submit will explain */ }
      }
    }
    window.addEventListener(STEP_UP_EVENT, onRequest)
    return () => {
      window.removeEventListener(STEP_UP_EVENT, onRequest)
      ;(window as any)[STEP_UP_HOST_FLAG] = false
    }
  }, [])

  function finish(ok: boolean) {
    resolver.current?.(ok); resolver.current = null
    setOpen(false); setValue(''); setError('')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      const payload = method === 'totp'
        ? { method, factorId, code: value }
        : { method, password: value }
      const res = await fetch('/api/auth/step-up', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) { setError(json.error || 'Could not confirm. Try again.'); return }
      finish(true)
    } catch {
      setError('Could not confirm. Check your connection and try again.')
    } finally { setBusy(false) }
  }

  if (!open) return null
  return (
    <>
      <div className="modal-bg" onClick={() => finish(false)} />
      <div className="modal" role="dialog" aria-modal="true" aria-label="Confirm it's you">
        <h2 className="modal-title">Confirm it&rsquo;s you</h2>
        <p className="modal-sub">
          {method === 'totp'
            ? 'Enter the 6-digit code from your authenticator app to continue.'
            : 'Enter your password to continue.'}
        </p>
        <form onSubmit={submit}>
          {error && <div className="auth-error" style={{ marginBottom: 12 }}>{error}</div>}
          <div className="fgrp">
            <label className="flbl">{method === 'totp' ? 'Authenticator code' : 'Password'}</label>
            <input
              className="finp" autoFocus required value={value}
              type={method === 'totp' ? 'text' : 'password'}
              inputMode={method === 'totp' ? 'numeric' : undefined}
              autoComplete={method === 'totp' ? 'one-time-code' : 'current-password'}
              maxLength={method === 'totp' ? 7 : 128}
              placeholder={method === 'totp' ? '123456' : ''}
              onChange={e => setValue(e.target.value)}
            />
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={() => finish(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !value || (method === 'totp' && !factorId)}>
              {busy ? <span className="spin" /> : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
