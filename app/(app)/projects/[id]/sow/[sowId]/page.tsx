'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import SowEditor from '@/components/sow/SowEditor'
import { sowStatusLabel, sowStatusColour, formatDate } from '@/lib/utils/format'

export default function SowEditorPage() {
  const params  = useParams()
  const router  = useRouter()
  const sowId   = params.sowId as string
  const projId  = params.id   as string

  const [sow,      setSow]      = useState<any>(null)
  const [loading,  setLoading]  = useState(true)
  const [sending,  setSending]  = useState(false)
  const [error,    setError]    = useState('')
  const [isLocked, setIsLocked] = useState(false)
  // The editor registers a function that writes every outstanding edit and reports success.
  const flushRef = useRef<null | (() => Promise<boolean>)>(null)
  const registerFlush = useCallback((fn: () => Promise<boolean>) => { flushRef.current = fn }, [])
  const [perms,    setPerms]    = useState<{ canEdit: boolean; canSend: boolean; canViewFinancials: boolean }>({ canEdit: false, canSend: false, canViewFinancials: false })

  useEffect(() => {
    fetch(`/api/sow/${sowId}`)
      .then(r => r.json())
      .then(json => {
        if (json.sow) {
          setSow(json.sow)
          // BUG-023: isLocked managed as local state — no reload required
          setIsLocked(!!json.sow.sent_at)
        }
        if (json.permissions) setPerms(json.permissions)
      })
      .finally(() => setLoading(false))
  }, [sowId])

  async function handleSend() {
    setSending(true); setError('')
    try {
      // Everything typed in the last moments must be stored BEFORE the server snapshots the
      // document for sending — otherwise those edits were silently left out of what the client got
      // (and the late autosave then bounced off the now-locked document).
      if (flushRef.current) {
        const saved = await flushRef.current()
        if (!saved) throw new Error('Some of your latest edits could not be saved. Resolve the "Save failed" notice above the editor, then send again.')
      }
      const post = async (acknowledgeWarnings: boolean) => {
        const res  = await fetch(`/api/sow/${sowId}/send`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ acknowledgeWarnings }),
        })
        return { res, json: await res.json().catch(() => ({} as any)) }
      }
      let { res, json } = await post(false)
      if (res.status === 409 && json.needsAcknowledgement) {
        const list: string[] = Array.isArray(json.warnings) && json.warnings.length ? json.warnings : [json.error]
        if (!confirm(`${list.join('\n\n')}\n\nSend it anyway?`)) return
        ;({ res, json } = await post(true))
      }
      if (!res.ok) throw new Error(json.error || 'Failed to send')
      if (json.pendingApproval) {
        // Not sent yet: it is waiting on an approval chain, so the document is NOT locked.
        alert(json.message || 'Sent for approval — the client will be notified once it clears.')
        router.push(`/projects/${projId}?tab=sow`)
        return
      }
      if (json.emailSent === false) {
        alert(`The SOW is marked as sent, but the email to the client could not be delivered (${json.emailError || 'provider error'}).\n\nOpen the project's SOW tab and use "Copy signing link" to send it to them yourself.`)
      }
      setIsLocked(true) // immediate — no reload (carry-forward §3.3)
      router.push(`/projects/${projId}?tab=sow`)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send')
    } finally { setSending(false) }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 400 }}>
        <span className="spin spin-dark" style={{ width: 24, height: 24 }} />
      </div>
    )
  }

  if (!sow) {
    return (
      <div style={{ padding: 40 }}>
        <div className="auth-error">SOW not found</div>
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Top bar */}
      <div style={{
        padding: '12px 24px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn-icon" onClick={() => router.push(`/projects/${projId}?tab=sow`)}>
            <i className="ti ti-arrow-left" style={{ fontSize: 15 }} />
          </button>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              SOW v{sow.version}
              <span className={`pill pill-${sow.status === 'signed' ? 'green' : sow.status === 'awaiting_signature' ? 'amber' : 'slate'} pill-sm`} style={{ marginLeft: 8 }}>
                {sowStatusLabel(sow.status)}
              </span>
            </div>
            {sow.sent_at && (
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                Sent {formatDate(sow.sent_at)}
                {sow.signed_at && ` · Signed ${formatDate(sow.signed_at)} by ${sow.signed_by}`}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{error}</span>}
          {/* FIX (section-9 re-audit): api/pdf/sow/[id] now 403s a viewer
              without VIEW_FINANCIALS (same fix as the invoice PDF route —
              see that route's own comment, and GET /api/sow/[id]'s new
              permissions.canViewFinancials flag this reads). This link
              used to be unconditional and would now dead-end for exactly
              the same viewers contractValue is already hidden from above. */}
          {perms.canViewFinancials && (
            <a
              href={`/api/pdf/sow/${sowId}`}
              target="_blank"
              className="btn btn-ghost btn-sm"
            >
              <i className="ti ti-download" style={{ fontSize: 12 }} />
              {isLocked ? 'Download PDF' : 'Preview PDF'}
            </a>
          )}
          {!isLocked && perms.canSend && (
            <button className="btn btn-primary btn-sm" onClick={handleSend} disabled={sending}>
              {sending
                ? <><span className="spin" style={{ width: 12, height: 12 }} /> Sending…</>
                : <><i className="ti ti-send" style={{ fontSize: 12 }} /> Send to client</>}
            </button>
          )}
          {/* FIX (fix round, SOW-G1): the API has always allowed withdrawing a
              changes_requested SOW too (same cancellation-notice email as
              awaiting_signature) — this page just never offered the button, even
              though ProjectDetail's version-history "View" link is exactly how an
              agency reaches a changes_requested SOW in the first place. */}
          {isLocked && (sow.status === 'awaiting_signature' || sow.status === 'changes_requested') && perms.canSend && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                if (!confirm('Withdraw this SOW? The client link will be deactivated.')) return
                setError('')
                try {
                  const res = await fetch(`/api/sow/${sowId}/withdraw`, { method: 'POST' })
                  // FIX (deep audit, section 7): this navigated away
                  // unconditionally, regardless of whether the withdraw
                  // actually succeeded — a failed withdraw (permission
                  // lapsed, already signed, network error) looked
                  // identical to a successful one, with no error shown
                  // and the SOW still silently live with the client.
                  if (!res.ok) {
                    const json = await res.json().catch(() => ({}))
                    setError(json.error || 'Failed to withdraw')
                    return
                  }
                  router.push(`/projects/${projId}?tab=sow`)
                } catch {
                  setError('Failed to withdraw')
                }
              }}
            >
              <i className="ti ti-x" style={{ fontSize: 12 }} /> Withdraw
            </button>
          )}
        </div>
      </div>

      {/* Editor */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <SowEditor
          sowId={sowId}
          sections={sow.sections || []}
          isLocked={isLocked}
          canSend={!isLocked && perms.canSend}
          canEdit={!isLocked && perms.canEdit}
          canViewFinancials={perms.canViewFinancials}
          // FIX (section-9 audit, 9-G6 / 9-G7 / 9-G8): the Payment
          // Schedule editor needs the contract value to show a running
          // total against it, table headers need the drafting language,
          // and a draft spawned by a client change request needs to show
          // what they actually asked for.
          contractValue={sow.contractValue ?? undefined}
          currency={sow.currency || undefined}
          language={sow.metadata?.language}
          changeRequest={sow.metadata?.changeRequest || null}
          msaReference={sow.metadata?.msaReference || null}
          registerFlush={registerFlush}
        />
      </div>
    </div>
  )
}
