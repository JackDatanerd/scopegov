// components/clients/ClientDangerZone.tsx
//
// FEATURE (independent pass, section 14): a client created by mistake — a typo, or the same company
// entered under two email addresses — could never be removed; the only control was Archive, so the
// roster only ever grew. This adds the two missing offboarding actions:
//   * Merge into another client — moves every project, contact and CC address across in one
//     database transaction, then removes this record (POST /api/clients/[id]/merge).
//   * Delete — only offered when the client has no projects at all, including soft-deleted ones,
//     matching DELETE /api/clients/[id]'s own check; a client blocked only by deleted project
//     records gets an explanation instead of a button that would just 409.

'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Other { id: string; name: string; email: string | null; status: string | null }

export default function ClientDangerZone({
  clientId, clientName, visibleProjectCount, totalProjectCount, others, canMerge, canDelete,
}: {
  clientId: string; clientName: string; visibleProjectCount: number; totalProjectCount: number
  others: Other[]; canMerge: boolean; canDelete: boolean
}) {
  const router = useRouter()
  const [merging, setMerging] = useState(false)
  const [targetId, setTargetId] = useState('')
  const [busy, setBusy] = useState<'merge' | 'delete' | null>(null)
  const [error, setError] = useState('')

  if (!canMerge && !canDelete) return null

  async function doMerge() {
    const target = others.find(o => o.id === targetId)
    if (!target) return
    if (!window.confirm(
      `Merge “${clientName}” into “${target.name}”?\n\nAll of ${clientName}'s projects, contacts and CC addresses move to ${target.name}, and ${clientName} is removed. This can't be undone.`,
    )) return
    setBusy('merge'); setError('')
    try {
      const res = await fetch(`/api/clients/${clientId}/merge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Merge failed')
      router.push(`/clients/${targetId}`)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed')
      setBusy(null)
    }
  }

  async function doDelete() {
    if (!window.confirm(`Delete “${clientName}” permanently? This can't be undone.`)) return
    setBusy('delete'); setError('')
    try {
      const res = await fetch(`/api/clients/${clientId}`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Delete failed')
      router.push('/clients')
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
      setBusy(null)
    }
  }

  return (
    <div style={{ marginTop: 20 }}>
      <div className="sec-hd" style={{ marginBottom: 12 }}><div className="sec-title">Manage client record</div></div>
      <div className="surface surface-p">
        {error && <div className="auth-error" style={{ marginBottom: 10 }}>{error}</div>}

        {canMerge && (
          !merging ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setMerging(true)} disabled={others.length === 0}
              title={others.length === 0 ? 'There is no other client to merge into' : 'Merge this client into another one'}>
              <i className="ti ti-git-merge" style={{ fontSize: 13 }} /> Merge into another client…
            </button>
          ) : (
            <div>
              <label className="flbl">Merge into</label>
              <select className="finp" value={targetId} onChange={e => setTargetId(e.target.value)} style={{ marginBottom: 8 }}>
                <option value="">Choose the client to keep…</option>
                {others.map(o => (
                  <option key={o.id} value={o.id}>{o.name}{o.email ? ` — ${o.email}` : ''}{o.status === 'archived' ? ' (archived)' : ''}</option>
                ))}
              </select>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={!targetId || busy !== null} onClick={doMerge}>
                  {busy === 'merge' ? <span className="spin" /> : 'Merge'}
                </button>
                <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => { setMerging(false); setTargetId('') }}>Cancel</button>
              </div>
            </div>
          )
        )}

        {/* FIX (independent pass round 2, section 14): the Delete button used to key off
            visibleProjectCount alone, so a client whose only projects were soft-deleted showed
            it as available and then always got a 409 from the API's stricter, "including deleted
            ones" check — with nothing on this page explaining why. Now the button only appears
            when totalProjectCount (matching the API's check) is actually 0; the in-between case
            (visibly empty but blocked by deleted project records) gets an explanation instead of
            a dead-end click. */}
        {canDelete && totalProjectCount === 0 && (
          <div style={{ marginTop: canMerge ? 12 : 0 }}>
            <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} disabled={busy !== null} onClick={doDelete}>
              {busy === 'delete' ? <span className="spin" /> : (<><i className="ti ti-trash" style={{ fontSize: 13 }} /> Delete client</>)}
            </button>
            <p style={{ fontSize: 11, color: 'var(--text-4)', margin: '6px 0 0' }}>
              Only possible while the client has no projects on record.
            </p>
          </div>
        )}
        {canDelete && totalProjectCount > 0 && visibleProjectCount === 0 && (
          <div style={{ marginTop: canMerge ? 12 : 0 }}>
            <p style={{ fontSize: 11, color: 'var(--text-4)', margin: 0 }}>
              This client can&apos;t be deleted — it still has {totalProjectCount} project{totalProjectCount === 1 ? '' : 's'} on
              record (including deleted ones). Archive it, or merge it into another client, instead.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
