'use client'
import { useState, useEffect } from 'react'
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
  const [perms,    setPerms]    = useState<{ canEdit: boolean; canSend: boolean }>({ canEdit: false, canSend: false })

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
      const res  = await fetch(`/api/sow/${sowId}/send`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
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
          <a
            href={`/api/pdf/sow/${sowId}`}
            target="_blank"
            className="btn btn-ghost btn-sm"
          >
            <i className="ti ti-download" style={{ fontSize: 12 }} />
            {isLocked ? 'Download PDF' : 'Preview PDF'}
          </a>
          {!isLocked && perms.canSend && (
            <button className="btn btn-primary btn-sm" onClick={handleSend} disabled={sending}>
              {sending
                ? <><span className="spin" style={{ width: 12, height: 12 }} /> Sending…</>
                : <><i className="ti ti-send" style={{ fontSize: 12 }} /> Send to client</>}
            </button>
          )}
          {isLocked && sow.status === 'awaiting_signature' && perms.canSend && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                if (!confirm('Withdraw this SOW? The client link will be deactivated.')) return
                await fetch(`/api/sow/${sowId}/withdraw`, { method: 'POST' })
                router.push(`/projects/${projId}?tab=sow`)
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
          // FIX (section-9 audit, 9-G6 / 9-G7 / 9-G8): the Payment
          // Schedule editor needs the contract value to show a running
          // total against it, table headers need the drafting language,
          // and a draft spawned by a client change request needs to show
          // what they actually asked for.
          contractValue={sow.contractValue ?? undefined}
          currency={sow.currency || undefined}
          language={sow.metadata?.language}
          changeRequest={sow.metadata?.changeRequest || null}
        />
      </div>
    </div>
  )
}
