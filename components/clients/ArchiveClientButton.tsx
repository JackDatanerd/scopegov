// components/clients/ArchiveClientButton.tsx
//
// FIX (audit round 6): clients.status (active/archived) has had a CHECK
// constraint since the initial schema, but nothing anywhere ever wrote it
// or read it — every client was permanently 'active' with no offboarding
// path. This is the missing control.

'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ArchiveClientButton({
  clientId, status, activeProjectCount = 0,
}: { clientId: string; status: string; activeProjectCount?: number }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const archived = status === 'archived'

  async function toggle() {
    // FEATURE (deep audit, section 14): archiving has never checked
    // whether the client still has active projects — 'archived' has zero
    // downstream enforcement anywhere else (Guardian keeps monitoring,
    // invoices/SOWs/COs still send fine), so this was a silent one-click
    // action with no signal that it might be premature. A confirm with
    // the actual count at least makes that an informed choice instead of
    // an invisible one.
    if (!archived && activeProjectCount > 0) {
      const ok = window.confirm(
        `This client has ${activeProjectCount} active project${activeProjectCount !== 1 ? 's' : ''}. ` +
        `Archiving only hides the client from the default list — it won't pause Guardian monitoring, invoicing, or any active work. Continue?`
      )
      if (!ok) return
    }

    setLoading(true); setError('')
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: archived ? 'active' : 'archived' }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Failed') }
      router.refresh()
    } catch (e) {
      // FIX (deep audit, section 14): failures used to only be
      // console.error'd — the button just stopped spinning with no
      // indication anything went wrong.
      setError(e instanceof Error ? e.message : 'Could not update this client.')
    } finally { setLoading(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button className="btn btn-ghost" disabled={loading} onClick={toggle} title={archived ? 'Reactivate this client' : 'Archive this client — hides it from the default client list'}>
        {loading ? <span className="spin" /> : (
          <>
            <i className={`ti ti-${archived ? 'archive-off' : 'archive'}`} style={{ fontSize: 13 }} />
            {archived ? 'Reactivate' : 'Archive'}
          </>
        )}
      </button>
      {error && <p style={{ fontSize: 11.5, color: 'var(--red)', margin: 0 }}>{error}</p>}
    </div>
  )
}
