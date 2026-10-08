// components/documents/ClientDetailsWarningModal.tsx
// Shown before a SOW / change order is sent when client details that print on it are empty.
// "Send anyway" is always available; "Edit client details" opens the client in a new tab so the draft stays put.
'use client'

export interface ClientDetailsInfo {
  clientId: string
  clientName: string
  missing: string[]
  editUrl: string
}

export interface AgencyDetailsInfo {
  missing: string[]
  fixes: { label: string; url: string }[]
}

export default function ClientDetailsWarningModal({
  info, agency, warnings, docLabel, busy, onSendAnyway, onCancel,
}: {
  info?: ClientDetailsInfo | null
  agency?: AgencyDetailsInfo | null
  warnings: string[]
  docLabel: string
  busy?: boolean
  onSendAnyway: () => void
  onCancel: () => void
}) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cdw-title"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div style={{ background: 'var(--surface, #fff)', borderRadius: 10, maxWidth: 460, width: '100%', padding: 24, boxShadow: '0 12px 40px rgba(0,0,0,.25)' }}>
        <div id="cdw-title" style={{ fontSize: 16, fontWeight: 600, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <i className="ti ti-alert-triangle" style={{ color: 'var(--amber, #B45309)' }} /> Details are incomplete
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>
          {warnings.map((w, i) => <p key={i} style={{ margin: '0 0 8px' }}>{w}</p>)}
          <p style={{ margin: '8px 0 0' }}>
            Add them now so your {docLabel} is complete, or send it as is.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 20 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
          {agency?.fixes.map(f => (
            <a key={f.url} className="btn btn-ghost btn-sm" href={f.url} target="_blank" rel="noopener noreferrer">
              <i className="ti ti-external-link" style={{ fontSize: 12 }} /> {f.label}
            </a>
          ))}
          {info && (
            <a className="btn btn-ghost btn-sm" href={info.editUrl} target="_blank" rel="noopener noreferrer">
              <i className="ti ti-external-link" style={{ fontSize: 12 }} /> Edit client details
            </a>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={onSendAnyway} disabled={busy}>
            {busy ? <span className="spin" /> : 'Send anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}
