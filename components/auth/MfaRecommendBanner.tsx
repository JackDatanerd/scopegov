// components/auth/MfaRecommendBanner.tsx
// Dismissible nudge for users whose role can see sensitive data and who have no second factor yet.
// Dismissal is remembered for 14 days in this browser only.
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

const KEY = 'sg_mfa_nudge_dismissed_at'
const TTL_MS = 14 * 24 * 60 * 60 * 1000

export default function MfaRecommendBanner() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    try {
      const at = Number(localStorage.getItem(KEY) || 0)
      setShow(!at || Date.now() - at > TTL_MS)
    } catch { setShow(true) }
  }, [])
  if (!show) return null
  return (
    <div className="banner" role="status" style={{ margin: '12px 24px 0' }}>
      <span>
        <strong>Add a second sign-in step.</strong>
        {' '}Your role can see client and financial data. We recommend protecting your account with an authenticator app.
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <Link href="/mfa-setup?next=/dashboard"><button className="btn btn-primary btn-sm">Set up 2FA</button></Link>
        <button className="btn btn-ghost btn-sm" onClick={() => { try { localStorage.setItem(KEY, String(Date.now())) } catch {} setShow(false) }}>Not now</button>
      </span>
    </div>
  )
}
