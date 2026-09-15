// components/clients/ArchiveClientButton.tsx
//
// FIX (audit round 6): clients.status (active/archived) has had a CHECK
// constraint since the initial schema, but nothing anywhere ever wrote it
// or read it — every client was permanently 'active' with no offboarding
// path. This is the missing control.

'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ArchiveClientButton({ clientId, status }: { clientId: string; status: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const archived = status === 'archived'

  async function toggle() {
    setLoading(true)
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: archived ? 'active' : 'archived' }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Failed') }
      router.refresh()
    } catch (e) {
      console.error(e)
    } finally { setLoading(false) }
  }

  return (
    <button className="btn btn-ghost" disabled={loading} onClick={toggle} title={archived ? 'Reactivate this client' : 'Archive this client — hides it from the default client list'}>
      {loading ? <span className="spin" /> : (
        <>
          <i className={`ti ti-${archived ? 'archive-off' : 'archive'}`} style={{ fontSize: 13 }} />
          {archived ? 'Reactivate' : 'Archive'}
        </>
      )}
    </button>
  )
}
