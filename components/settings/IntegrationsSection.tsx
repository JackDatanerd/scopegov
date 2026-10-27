'use client'

// Settings → Integrations → Webhooks & API keys. The first live part of the Integrations tab, and the surface the
// native integrations (Slack, Zapier, HubSpot, Google Drive) will plug into. Talks to /api/workspace/integrations/*.
// Secrets (a webhook's signing secret, an API key) are shown exactly once, in a banner, right after creation.

import { useCallback, useEffect, useState } from 'react'
import { fetchWithStepUp } from '@/lib/client/step-up'
import { useDialogs } from '@/components/ui/Dialogs'

interface Health { pending: number; succeeded: number; dead: number; last?: { status: string; code: number | null; error: string | null; at: string } }
interface Sub { id: string; kind: 'webhook' | 'zapier' | 'slack'; name: string; target_url: string; event_types: string[]; active: boolean; disabled_reason: string | null; last_success_at: string | null; health: Health }
interface Key { id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null }
interface Overview {
  encryptionConfigured: boolean; allowed: boolean; lapsed: boolean; minPlan: string; nativeMinPlan: string
  limits: { subscriptions: number; apiKeys: number }; eventTypes: string[]; subscriptions: Sub[]; apiKeys: Key[]
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')
const subtle: React.CSSProperties = { fontSize: 11, color: 'var(--text-3)' }

export default function IntegrationsSection() {
  const dialogs = useDialogs()
  const [data, setData] = useState<Overview | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [form, setForm] = useState<{ name: string; url: string; events: string[] } | null>(null)
  const [keyName, setKeyName] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/workspace/integrations', { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not load integrations.')
      setData(json); setLoadErr('')
    } catch (e: any) { setLoadErr(e.message) }
  }, [])
  useEffect(() => { load() }, [load])

  async function call(url: string, method: string, body?: unknown): Promise<any | null> {
    setBusy(true); setErr(''); setNote('')
    try {
      const res = await fetchWithStepUp(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Something went wrong. Please try again.')
      return json
    } catch (e: any) { setErr(e.message); return null } finally { setBusy(false) }
  }

  async function createWebhook(e: React.FormEvent) {
    e.preventDefault()
    if (!form) return
    const json = await call('/api/workspace/integrations/webhooks', 'POST', { name: form.name, url: form.url, events: form.events })
    if (json) { setSecret({ label: 'Signing secret', value: json.secret }); setForm(null); load() }
  }
  async function createKey(e: React.FormEvent) {
    e.preventDefault()
    const json = await call('/api/workspace/integrations/api-keys', 'POST', { name: keyName })
    if (json) { setSecret({ label: 'API key', value: json.key }); setKeyName(''); load() }
  }
  async function act(url: string, method: string, body: unknown, ok: string) {
    const json = await call(url, method, body)
    if (json) { setNote(ok); if (json.secret) setSecret({ label: 'New signing secret', value: json.secret }); load() }
  }

  if (loadErr) return <p className="ferr">{loadErr}</p>
  if (!data) return <p style={subtle}>Loading…</p>

  const canWrite = data.allowed && data.encryptionConfigured
  const webhooks = data.subscriptions.filter(s => s.kind === 'webhook')
  const zaps = data.subscriptions.filter(s => s.kind === 'zapier')
  return (
    <div style={{ marginBottom: 28 }}>
      {!data.allowed && (
        <div className="settings-section" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{data.lapsed ? 'Read-only workspace' : `Webhooks and API keys need the ${data.minPlan} plan or above`}</div>
          <div style={subtle}>{data.lapsed ? 'Reactivate your subscription to deliver events again.' : 'Upgrade in Settings → Billing to connect ScopeGov to your own systems.'}</div>
        </div>
      )}
      {data.allowed && !data.encryptionConfigured && (
        <div className="settings-section" style={{ marginBottom: 16, border: '1px solid #FECACA' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Integrations are not switched on for this server yet</div>
          <div style={subtle}>The server operator needs to set INTEGRATIONS_ENCRYPTION_KEY before webhooks or API keys can be created.</div>
        </div>
      )}
      {err && <p className="ferr">{err}</p>}
      {note && <p style={{ ...subtle, color: 'var(--green, #1A5C3A)' }}>{note}</p>}
      {secret && (
        <div className="settings-section" style={{ marginBottom: 16, border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{secret.label} — copy it now</div>
          <div style={subtle}>It is shown only once and cannot be viewed again.</div>
          <code style={{ display: 'block', margin: '8px 0', padding: 8, background: 'var(--surface-2)', wordBreak: 'break-all', fontSize: 12 }}>{secret.value}</code>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard?.writeText(secret.value).catch(() => {}) }}>Copy</button>{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSecret(null)}>I have saved it</button>
        </div>
      )}

      <div className="settings-section">
        <div className="settings-section-title">Webhooks</div>
        <div style={{ ...subtle, marginBottom: 10 }}>
          ScopeGov sends a signed JSON POST to your URL when something happens (a SOW is signed, a Guardian flag is raised, an invoice is paid…).
          Verify the <code>X-ScopeGov-Signature</code> header (HMAC-SHA256 of <code>timestamp.body</code> with your signing secret) and de-duplicate on <code>X-ScopeGov-Delivery</code>.
          Failed deliveries are retried for about a day.
        </div>
        {webhooks.length === 0 && <div style={subtle}>No webhooks yet.</div>}
        {webhooks.map(s => (
          <div key={s.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--surface-2)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name} {!s.active && <span style={{ ...subtle, color: 'var(--red)' }}>· off</span>}</div>
                <div style={{ ...subtle, wordBreak: 'break-all' }}>{s.target_url}</div>
                <div style={subtle}>{s.event_types.length} event{s.event_types.length === 1 ? '' : 's'} · last delivered {when(s.last_success_at)} · {s.health.pending} waiting, {s.health.dead} failed</div>
                {s.health.last?.status === 'dead' || (s.health.last?.error && s.health.last.status === 'pending')
                  ? <div style={{ ...subtle, color: 'var(--red)' }}>Last problem: {s.health.last?.error}</div> : null}
                {s.disabled_reason && <div style={{ ...subtle, color: 'var(--red)' }}>{s.disabled_reason}</div>}
              </div>
              <button className="btn btn-ghost btn-sm" disabled={busy || !canWrite} onClick={() => act(`/api/workspace/integrations/webhooks/${s.id}/test`, 'POST', undefined, 'Test event queued — it is delivered within about a minute.')}>Send test</button>
              <button className="btn btn-ghost btn-sm" disabled={busy || !canWrite} onClick={() => act(`/api/workspace/integrations/webhooks/${s.id}`, 'PATCH', { active: !s.active }, s.active ? 'Webhook turned off.' : 'Webhook turned on.')}>{s.active ? 'Turn off' : 'Turn on'}</button>
              <button className="btn btn-ghost btn-sm" disabled={busy || !canWrite} onClick={async () => { if (await dialogs.confirm('Replace the signing secret? The old one stops working immediately.')) act(`/api/workspace/integrations/webhooks/${s.id}`, 'PATCH', { rotateSecret: true }, 'Signing secret replaced.') }}>New secret</button>
              <button className="btn btn-ghost btn-sm" disabled={busy || !data.allowed} onClick={async () => { if (await dialogs.confirm(`Delete “${s.name}”? Queued deliveries are dropped.`)) act(`/api/workspace/integrations/webhooks/${s.id}`, 'DELETE', undefined, 'Webhook deleted.') }}>Delete</button>
            </div>
          </div>
        ))}

        {form ? (
          <form onSubmit={createWebhook} style={{ marginTop: 14 }}>
            <div className="f2" style={{ marginBottom: 10 }}>
              <div className="fgrp"><label className="flbl">Name</label>
                <input className="finp" maxLength={80} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
              <div className="fgrp"><label className="flbl">Endpoint URL</label>
                <input className="finp" placeholder="https://example.com/hooks/scopegov" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })} /></div>
            </div>
            <div className="flbl" style={{ marginBottom: 6 }}>Events</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBottom: 12 }}>
              {data.eventTypes.map(t => (
                <label key={t} style={{ fontSize: 12 }}>
                  <input type="checkbox" checked={form.events.includes(t)} onChange={e => setForm({ ...form, events: e.target.checked ? [...form.events, t] : form.events.filter(x => x !== t) })} /> {t}
                </label>
              ))}
            </div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !form.name.trim() || !form.url.trim() || form.events.length === 0}>Create webhook</button>{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm(null)}>Cancel</button>
          </form>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} disabled={!canWrite || webhooks.length >= data.limits.subscriptions}
            onClick={() => setForm({ name: '', url: '', events: [] })}>Add webhook</button>
        )}
      </div>

      <div className="settings-section" style={{ marginTop: 16 }}>
        <div className="settings-section-title">Zapier</div>
        <div style={{ ...subtle, marginBottom: 10 }}>
          Zapier connects with an API key (below). Add ScopeGov in Zapier, paste the key when asked, and pick a trigger such as “Invoice Paid”.
          Each active Zap that uses a ScopeGov trigger appears here; turning the Zap off in Zapier removes it.
          You can only pick triggers for events you could see in ScopeGov yourself.
        </div>
        {zaps.length === 0 && <div style={subtle}>No Zaps are using ScopeGov yet.</div>}
        {zaps.map(s => (
          <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--surface-2)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name} {!s.active && <span style={{ ...subtle, color: 'var(--red)' }}>· off</span>}</div>
              <div style={subtle}>last delivered {when(s.last_success_at)} · {s.health.pending} waiting, {s.health.dead} failed</div>
              {s.disabled_reason && <div style={{ ...subtle, color: 'var(--red)' }}>{s.disabled_reason}</div>}
            </div>
            <button className="btn btn-ghost btn-sm" disabled={busy || !canWrite} onClick={() => act(`/api/workspace/integrations/webhooks/${s.id}`, 'PATCH', { active: !s.active }, s.active ? 'Zap trigger turned off.' : 'Zap trigger turned on.')}>{s.active ? 'Turn off' : 'Turn on'}</button>
            <button className="btn btn-ghost btn-sm" disabled={busy || !data.allowed} onClick={async () => { if (await dialogs.confirm(`Remove “${s.name}”? The Zap using it stops receiving events.`)) act(`/api/workspace/integrations/webhooks/${s.id}`, 'DELETE', undefined, 'Zap trigger removed.') }}>Remove</button>
          </div>
        ))}
      </div>

      <div className="settings-section" style={{ marginTop: 16 }}>
        <div className="settings-section-title">API keys</div>
        <div style={{ ...subtle, marginBottom: 10 }}>Keys let tools like Zapier act for this workspace. Treat one like a password; revoke it if it leaks.</div>
        {data.apiKeys.length === 0 && <div style={subtle}>No API keys yet.</div>}
        {data.apiKeys.map(k => (
          <div key={k.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--surface-2)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{k.name}</div>
              <div style={subtle}><code>{k.key_prefix}…</code> · created {when(k.created_at)} · last used {when(k.last_used_at)}</div>
            </div>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => { if (await dialogs.confirm(`Revoke “${k.name}”? Anything using it stops working immediately.`)) act(`/api/workspace/integrations/api-keys/${k.id}`, 'DELETE', undefined, 'Key revoked.') }}>Revoke</button>
          </div>
        ))}
        <form onSubmit={createKey} style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
          <div className="fgrp" style={{ flex: 1 }}><label className="flbl">New key name</label>
            <input className="finp" maxLength={80} placeholder="e.g. Zapier" value={keyName} onChange={e => setKeyName(e.target.value)} /></div>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !canWrite || !keyName.trim() || data.apiKeys.length >= data.limits.apiKeys}>Create key</button>
        </form>
      </div>

      <div style={{ ...subtle, marginTop: 10 }}>Native Slack, HubSpot and Google Drive connections will need the {data.nativeMinPlan} plan or above.</div>
    </div>
  )
}
