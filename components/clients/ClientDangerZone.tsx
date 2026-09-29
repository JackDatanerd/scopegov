// components/clients/ClientDangerZone.tsx
//
// FEATURE (independent pass, section 14): a client created by mistake — a typo, or the same company
// entered under two email addresses — could never be removed; the only control was Archive, so the
// roster only ever grew. This adds the two missing offboarding actions:
//   * Merge into another client — moves every project, and as many contacts/CC addresses as fit
//     under the target's own limits, across in one database transaction, then removes this record
//     (POST /api/clients/[id]/merge).
//   * Delete — only offered when the client has no projects at all, including soft-deleted ones,
//     matching DELETE /api/clients/[id]'s own check; a client blocked only by deleted project
//     records gets an explanation instead of a button that would just 409.
//
// FIX (independent pass round 5, section 14): merge_clients() (089) caps how many of the source's
// contacts survive a merge at the target's remaining room under the 25-per-client limit, and
// re-promotes the source's primary contact on the target if the target had none of its own — see
// that migration's comment for the full reasoning. doMerge() below surfaces `contacts_dropped`
// (previously silent) so the loss, when it happens, is at least visible to whoever merged.
//
// FIX (independent pass round 6, section 14): merge_clients() (097) reports the parallel cc_emails
// cap loss the same way — `cc_dropped` — since that cap silently dropped whatever didn't fit under
// MAX_CC_EMAILS (10), most often the source client's own primary email, the one address the merge is
// specifically meant to carry over. Combined into one alert with contacts_dropped rather than two
// separate blocking popups when a merge happens to hit both caps at once.

// FIX (independent pass 2, section 14): the list of clients to merge into was fetched server-side with
// `.limit(500)` and no search — in a workspace with more than 500 clients, everything past #500 (A–Z) could
// not be chosen, with no hint why. Targets are now loaded on demand from GET /api/clients (paged up to 5,000,
// with a `truncated` flag) when the merge picker is opened, and the picker has a search box. The merge
// confirm text also now says what happens to the source's billing/notes fields (migration 098).

'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Other { id: string; name: string; email: string | null; status: string | null }

const MAX_OPTIONS_SHOWN = 300

export default function ClientDangerZone({
  clientId, clientName, visibleProjectCount, totalProjectCount, canMerge, canDelete, canSeeAllProjects = true,
}: {
  clientId: string; clientName: string; visibleProjectCount: number; totalProjectCount: number
  canMerge: boolean; canDelete: boolean; canSeeAllProjects?: boolean
}) {
  const router = useRouter()
  const [merging, setMerging] = useState(false)
  const [targetId, setTargetId] = useState('')
  const [others, setOthers] = useState<Other[] | null>(null)
  const [othersTruncated, setOthersTruncated] = useState(false)
  const [loadingOthers, setLoadingOthers] = useState(false)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<'merge' | 'delete' | null>(null)
  const [error, setError] = useState('')

  if (!canMerge && !canDelete) return null

  async function openMerge() {
    setMerging(true); setError('')
    if (others) return
    setLoadingOthers(true)
    try {
      const res = await fetch('/api/clients')
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not load clients')
      setOthers((json.clients || []).filter((c: any) => c.id !== clientId)
        .map((c: any) => ({ id: c.id, name: c.name, email: c.email ?? null, status: c.status ?? null })))
      setOthersTruncated(json.truncated === true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load clients')
      setMerging(false)
    } finally { setLoadingOthers(false) }
  }

  const q = filter.trim().toLowerCase()
  const matching = (others || []).filter(o => !q || o.name.toLowerCase().includes(q) || (o.email || '').toLowerCase().includes(q))
  const shown = matching.slice(0, MAX_OPTIONS_SHOWN)
  const selected = (others || []).find(o => o.id === targetId)
  if (selected && !shown.some(o => o.id === selected.id)) shown.unshift(selected)

  async function doMerge() {
    const target = (others || []).find(o => o.id === targetId)
    if (!target) return
    if (!window.confirm(
      `Merge “${clientName}” into “${target.name}”?\n\nAll of ${clientName}'s projects, and as many of its contacts and CC addresses as fit under ${target.name}'s limits, move to ${target.name}; ${clientName} is then removed. ${target.name}'s own details always win — ${clientName}'s billing address, VAT number, phone, timezone, payment terms, company and notes are only copied across where ${target.name} has none. This can't be undone.`,
    )) return
    setBusy('merge'); setError('')
    try {
      const res = await fetch(`/api/clients/${clientId}/merge`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Merge failed')
      // FIX (independent pass round 5, section 14): merge_clients() (089) can now leave some of
      // the source's contacts behind if the target is already near the 25-contact limit — silent
      // otherwise, since this immediately navigates away from a page that could have shown them.
      // FIX (independent pass round 6, section 14): same idea for cc_emails — merge_clients() (097)
      // can now leave some of the source's CC addresses (including its own primary email) behind if
      // the target is already near the 10-address cap. Both warnings combine into one alert so a
      // merge that hits both caps doesn't pop two dialogs in a row.
      const warnings: string[] = []
      if (json.contacts_dropped > 0) {
        warnings.push(
          `${target.name} already had close to the maximum of 25 contacts, so ` +
          `${json.contacts_dropped} contact${json.contacts_dropped === 1 ? '' : 's'} from ${clientName} ` +
          `could not be carried over and ${json.contacts_dropped === 1 ? 'was' : 'were'} not kept.`
        )
      }
      if (json.cc_dropped > 0) {
        warnings.push(
          `${target.name} already had close to the maximum of 10 CC addresses, so ` +
          `${json.cc_dropped} CC address${json.cc_dropped === 1 ? '' : 'es'} from ${clientName} ` +
          `(possibly including its own email) could not be carried over and ${json.cc_dropped === 1 ? 'was' : 'were'} not kept.`
        )
      }
      if (json.notes_truncated === true) {
        warnings.push(`${target.name}'s notes were too long to hold all of ${clientName}'s notes, so the end of them was cut off.`)
      }
      if (warnings.length > 0) window.alert(`Merged. ${warnings.join(' ')}`)
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
            <button className="btn btn-ghost btn-sm" onClick={openMerge} disabled={loadingOthers}
              title="Merge this client into another one">
              {loadingOthers ? <span className="spin" /> : <><i className="ti ti-git-merge" style={{ fontSize: 13 }} /> Merge into another client…</>}
            </button>
          ) : (
            <div>
              <label className="flbl">Merge into</label>
              {(others || []).length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 8px' }}>There is no other client to merge into.</p>
              ) : (
                <>
                  <input className="finp" value={filter} onChange={e => setFilter(e.target.value)}
                    placeholder="Search by name or email…" style={{ marginBottom: 6 }} />
                  <select className="finp" value={targetId} onChange={e => setTargetId(e.target.value)} style={{ marginBottom: 8 }}>
                    <option value="">{matching.length === 0 ? 'No client matches your search' : 'Choose the client to keep…'}</option>
                    {shown.map(o => (
                      <option key={o.id} value={o.id}>{o.name}{o.email ? ` — ${o.email}` : ''}{o.status === 'archived' ? ' (archived)' : ''}</option>
                    ))}
                  </select>
                  {matching.length > MAX_OPTIONS_SHOWN && (
                    <p style={{ fontSize: 11, color: 'var(--text-4)', margin: '0 0 8px' }}>Showing the first {MAX_OPTIONS_SHOWN} of {matching.length} matches — type more to narrow it down.</p>
                  )}
                  {othersTruncated && (
                    <p style={{ fontSize: 11, color: 'var(--text-4)', margin: '0 0 8px' }}>This workspace has more clients than can be listed here; the client you want may not appear.</p>
                  )}
                </>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={!targetId || busy !== null} onClick={doMerge}>
                  {busy === 'merge' ? <span className="spin" /> : 'Merge'}
                </button>
                <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => { setMerging(false); setTargetId(''); setFilter('') }}>Cancel</button>
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
              {canSeeAllProjects
                ? <>This client can&apos;t be deleted — it still has {totalProjectCount} project{totalProjectCount === 1 ? '' : 's'} on
                    record (including deleted ones). Archive it, or merge it into another client, instead.</>
                : <>This client can&apos;t be deleted — it still has projects on record. Archive it instead.</>}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
