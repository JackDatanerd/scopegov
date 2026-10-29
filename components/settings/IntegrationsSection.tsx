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
interface SlackRule { id: string; channel: string; is_private: boolean; event_types: string[]; active: boolean; disabled_reason: string | null; last_success_at: string | null; health: Health }
interface SlackInfo { configured: boolean; allowed: boolean; connection: { team_name: string | null; status: string; last_error: string | null; connected_at: string } | null; rules: SlackRule[] }
interface DriveInfo {
  configured: boolean; allowed: boolean; eventLabels: Record<string, string>; archived: number
  connection: { account_email: string | null; status: string; last_error: string | null; connected_at: string; folder_url: string | null } | null
  rule: { event_types: string[]; active: boolean; disabled_reason: string | null; last_success_at: string | null; health: Health } | null
}
const DRIVE_RESULT: Record<string, { text: string; bad?: boolean }> = {
  connected: { text: 'Google Drive is connected. Executed documents will now be copied to the “ScopeGov Archive” folder.' },
  denied: { text: 'Google Drive connection cancelled.', bad: true },
  expired: { text: 'That Google link expired. Please try connecting again.', bad: true },
  forbidden: { text: 'Your account or plan cannot connect Google Drive.', bad: true },
  scope: { text: 'Google Drive was not connected because the Drive permission was unticked. Connect again and leave “See, edit, create and delete only the specific Google Drive files you use with this app” ticked.', bad: true },
  api: { text: 'Google accepted the sign-in but Drive could not be used. Ask the server operator to check that the Google Drive API is enabled for the Google Cloud project.', bad: true },
  failed: { text: 'Google Drive could not be connected. Please try again.', bad: true },
}
interface HubspotInfo {
  configured: boolean; allowed: boolean; eventLabels: Record<string, string>; deals: number
  connection: { portal: string | null; user_email: string | null; status: string; last_error: string | null; connected_at: string; open_url: string | null } | null
  rule: { event_types: string[]; active: boolean; disabled_reason: string | null; last_success_at: string | null; pipeline_id: string | null; include_amounts: boolean; health: Health } | null
}
const HUBSPOT_RESULT: Record<string, { text: string; bad?: boolean }> = {
  connected: { text: 'HubSpot is connected. Signed SOWs will now create companies, contacts and Closed-won deals.' },
  denied: { text: 'HubSpot connection cancelled.', bad: true },
  expired: { text: 'That HubSpot link expired. Please try connecting again.', bad: true },
  forbidden: { text: 'Your account or plan cannot connect HubSpot (it also needs permission to view client data).', bad: true },
  scope: { text: 'HubSpot was not connected because not every requested permission was granted. Connect again and accept them all.', bad: true },
  api: { text: 'HubSpot accepted the sign-in but its deals could not be read. Check that your HubSpot account has Deals.', bad: true },
  failed: { text: 'HubSpot could not be connected. Please try again.', bad: true },
}
interface Channel { id: string; name: string; is_private: boolean; is_member: boolean }
const SLACK_RESULT: Record<string, { text: string; bad?: boolean }> = {
  connected: { text: 'Slack is connected. Choose a channel below to start receiving events.' },
  denied: { text: 'Slack connection cancelled.', bad: true },
  expired: { text: 'That Slack link expired. Please try connecting again.', bad: true },
  forbidden: { text: 'Your account or plan cannot connect Slack.', bad: true },
  failed: { text: 'Slack could not be connected. Please try again.', bad: true },
}
interface Overview {
  encryptionConfigured: boolean; allowed: boolean; lapsed: boolean; minPlan: string; nativeMinPlan: string
  limits: { subscriptions: number; apiKeys: number }; eventTypes: string[]; subscriptions: Sub[]; apiKeys: Key[]; slack: SlackInfo; drive: DriveInfo; hubspot: HubspotInfo
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
  const [slackForm, setSlackForm] = useState<{ channel: string; events: string[] } | null>(null)
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [slackResult, setSlackResult] = useState<string | null>(null)
  const [driveResult, setDriveResult] = useState<string | null>(null)
  const [hubspotResult, setHubspotResult] = useState<string | null>(null)
  const [pipelines, setPipelines] = useState<Array<{ id: string; label: string }> | null>(null)

  // Slack sends the browser back to ?tab=integrations&slack=<result>; show it once and tidy the address bar.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const r = p.get('slack'), d = p.get('drive'), hs = p.get('hubspot')
    if (r || d || hs) {
      if (r) { setSlackResult(r); p.delete('slack') }
      if (d) { setDriveResult(d); p.delete('drive') }
      if (hs) { setHubspotResult(hs); p.delete('hubspot') }
      window.history.replaceState(null, '', `${window.location.pathname}${p.toString() ? '?' + p : ''}`)
    }
  }, [])

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
  async function connectSlack() {
    const json = await call('/api/workspace/integrations/slack/connect', 'POST')
    if (json?.url) window.location.href = json.url
  }
  async function connectHubspot() {
    const json = await call('/api/workspace/integrations/hubspot/connect', 'POST')
    if (json?.url) window.location.href = json.url
  }
  async function loadPipelines() {
    if (pipelines) return
    try {
      const res = await fetch('/api/workspace/integrations/hubspot/pipelines', { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (res.ok) setPipelines(json.pipelines)
    } catch { /* the select simply shows the current pipeline id */ }
  }
  async function backfillHubspot() {
    const json = await call('/api/workspace/integrations/hubspot/backfill', 'POST')
    if (json) {
      setNote(json.queued
        ? `Queued ${json.queued} earlier project${json.queued === 1 ? '' : 's'} for HubSpot${json.alreadySynced ? ` (${json.alreadySynced} already there)` : ''}${json.capped ? ' — the most recent 200; run it again later for older ones' : ''}. They arrive over the next few minutes.`
        : json.alreadySynced ? 'Every signed project is already in HubSpot.' : 'No earlier signed projects were found.')
      load()
    }
  }
  async function connectDrive() {
    const json = await call('/api/workspace/integrations/google-drive/connect', 'POST')
    if (json?.url) window.location.href = json.url
  }
  async function backfillDrive() {
    const json = await call('/api/workspace/integrations/google-drive/backfill', 'POST')
    if (json) {
      setNote(json.queued
        ? `Queued ${json.queued} earlier document${json.queued === 1 ? '' : 's'} for Drive${json.alreadyArchived ? ` (${json.alreadyArchived} already there)` : ''}${json.capped ? ' — the most recent 200 of each type; run it again later for older ones' : ''}. They arrive over the next few minutes.`
        : json.alreadyArchived ? 'Everything with a stored executed PDF is already in Drive.' : 'No earlier executed documents with a stored PDF were found.')
      load()
    }
  }
  async function openSlackForm() {
    setSlackForm({ channel: '', events: [] })
    if (channels) return
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/workspace/integrations/slack/channels', { cache: 'no-store' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || 'Could not load Slack channels.')
      setChannels(json.channels)
    } catch (e: any) { setErr(e.message); setSlackForm(null) } finally { setBusy(false) }
  }
  async function createSlackRule(e: React.FormEvent) {
    e.preventDefault()
    if (!slackForm) return
    const json = await call('/api/workspace/integrations/slack/rules', 'POST', { channel_id: slackForm.channel, events: slackForm.events })
    if (json) { setSlackForm(null); setNote('Rule added. Use “Send test” to check it.'); load() }
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

      {hubspotResult && HUBSPOT_RESULT[hubspotResult] && (
        <p style={{ ...subtle, color: HUBSPOT_RESULT[hubspotResult].bad ? 'var(--red)' : 'var(--green, #1A5C3A)', marginBottom: 12 }}>{HUBSPOT_RESULT[hubspotResult].text}</p>
      )}
      {driveResult && DRIVE_RESULT[driveResult] && (
        <p style={{ ...subtle, color: DRIVE_RESULT[driveResult].bad ? 'var(--red)' : 'var(--green, #1A5C3A)', marginBottom: 12 }}>{DRIVE_RESULT[driveResult].text}</p>
      )}
      {slackResult && SLACK_RESULT[slackResult] && (
        <p style={{ ...subtle, color: SLACK_RESULT[slackResult].bad ? 'var(--red)' : 'var(--green, #1A5C3A)', marginBottom: 12 }}>{SLACK_RESULT[slackResult].text}</p>
      )}

      <div className="settings-section" style={{ marginBottom: 16 }}>
        <div className="settings-section-title">Slack</div>
        {!data.slack.allowed ? (
          <div style={subtle}>{data.lapsed ? 'Reactivate your subscription to use Slack.' : `Slack needs the ${data.nativeMinPlan} plan or above.`}</div>
        ) : !data.slack.configured ? (
          <div style={subtle}>Slack is not set up on this server yet. The operator needs SLACK_CLIENT_ID and SLACK_CLIENT_SECRET (see integrations/slack/README.md).</div>
        ) : !data.slack.connection ? (
          <>
            <div style={{ ...subtle, marginBottom: 10 }}>Post scope flags, signed SOWs, payments and more into a Slack channel, each with a link back to the project.</div>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !data.encryptionConfigured} onClick={connectSlack}>Add to Slack</button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Connected to {data.slack.connection.team_name || 'Slack'}{data.slack.connection.status !== 'active' && <span style={{ ...subtle, color: 'var(--red)' }}> · needs reconnecting</span>}</div>
                {data.slack.connection.status !== 'active' && <div style={{ ...subtle, color: 'var(--red)' }}>{data.slack.connection.last_error || 'The connection stopped working.'} Reconnect to switch your rules back on.</div>}
              </div>
              {data.slack.connection.status !== 'active' && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={connectSlack}>Reconnect</button>}
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => { if (await dialogs.confirm('Disconnect Slack? Its rules are deleted and the ScopeGov app’s access is revoked.')) act('/api/workspace/integrations/slack', 'DELETE', undefined, 'Slack disconnected.') }}>Disconnect</button>
            </div>
            {data.slack.rules.length === 0 && <div style={subtle}>No channels yet.</div>}
            {data.slack.rules.map(r => (
              <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--surface-2)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{r.is_private ? '🔒 ' : '#'}{r.channel.replace(/^#/, '')} {!r.active && <span style={{ ...subtle, color: 'var(--red)' }}>· off</span>}</div>
                  <div style={subtle}>{r.event_types.length} event{r.event_types.length === 1 ? '' : 's'} · last posted {when(r.last_success_at)} · {r.health.pending} waiting, {r.health.dead} failed</div>
                  {r.disabled_reason && <div style={{ ...subtle, color: 'var(--red)' }}>{r.disabled_reason}</div>}
                  {r.health.last?.error && r.health.last.status !== 'succeeded' && <div style={{ ...subtle, color: 'var(--red)' }}>Last problem: {r.health.last.error}</div>}
                </div>
                <button className="btn btn-ghost btn-sm" disabled={busy || !canWrite} onClick={() => act(`/api/workspace/integrations/slack/rules/${r.id}/test`, 'POST', undefined, 'Test message queued — it arrives within about a minute.')}>Send test</button>
                <button className="btn btn-ghost btn-sm" disabled={busy || !canWrite} onClick={() => act(`/api/workspace/integrations/slack/rules/${r.id}`, 'PATCH', { active: !r.active }, r.active ? 'Rule turned off.' : 'Rule turned on.')}>{r.active ? 'Turn off' : 'Turn on'}</button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => { if (await dialogs.confirm(`Stop posting to ${r.is_private ? '' : '#'}${r.channel.replace(/^#/, '')}?`)) act(`/api/workspace/integrations/slack/rules/${r.id}`, 'DELETE', undefined, 'Rule deleted.') }}>Delete</button>
              </div>
            ))}
            {slackForm ? (
              <form onSubmit={createSlackRule} style={{ marginTop: 14 }}>
                <div className="fgrp" style={{ marginBottom: 10 }}>
                  <label className="flbl">Channel</label>
                  <select className="finp" value={slackForm.channel} onChange={e => setSlackForm({ ...slackForm, channel: e.target.value })}>
                    <option value="">{channels ? 'Choose a channel…' : 'Loading…'}</option>
                    {(channels || []).filter(c => !data.slack.rules.some(r => r.channel.replace(/^#/, '') === c.name)).map(c => (
                      <option key={c.id} value={c.id}>{c.is_private ? '🔒 ' : '#'}{c.name}</option>
                    ))}
                  </select>
                  <div style={subtle}>Private channels only appear once you have invited the app (/invite @ScopeGov).</div>
                </div>
                <div className="flbl" style={{ marginBottom: 6 }}>Post these events</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBottom: 12 }}>
                  {data.eventTypes.map(t => (
                    <label key={t} style={{ fontSize: 12 }}>
                      <input type="checkbox" checked={slackForm.events.includes(t)} onChange={e => setSlackForm({ ...slackForm, events: e.target.checked ? [...slackForm.events, t] : slackForm.events.filter(x => x !== t) })} /> {t}
                    </label>
                  ))}
                </div>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !slackForm.channel || slackForm.events.length === 0}>Add channel</button>{' '}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSlackForm(null)}>Cancel</button>
              </form>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} disabled={busy || !canWrite || data.slack.connection.status !== 'active' || data.slack.rules.length >= 10} onClick={openSlackForm}>Add channel</button>
            )}
          </>
        )}
      </div>

      <div className="settings-section" style={{ marginBottom: 16 }}>
        <div className="settings-section-title">HubSpot</div>
        {!data.hubspot.allowed ? (
          <div style={subtle}>{data.lapsed ? 'Reactivate your subscription to use HubSpot.' : `HubSpot needs the ${data.nativeMinPlan} plan or above.`}</div>
        ) : !data.hubspot.configured ? (
          <div style={subtle}>HubSpot is not set up on this server yet. The operator needs HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET (see integrations/hubspot/README.md).</div>
        ) : !data.hubspot.connection ? (
          <>
            <div style={{ ...subtle, marginBottom: 10 }}>
              Keep your CRM in step without retyping. When a SOW is signed, ScopeGov creates the company and contact (or links to the ones you already have) and a
              <strong> Closed-won deal</strong>, then adds the change orders, scope flags and payments to the deal’s timeline. It only ever <em>adds</em> records; it never edits your existing contacts or companies.
              Connecting needs permission to view client data.
            </div>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !data.encryptionConfigured} onClick={connectHubspot}>Connect HubSpot</button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  Connected to {data.hubspot.connection.portal || 'HubSpot'}
                  {data.hubspot.connection.status !== 'active' && <span style={{ ...subtle, color: 'var(--red)' }}> · needs reconnecting</span>}
                </div>
                <div style={subtle}>
                  {data.hubspot.deals} deal{data.hubspot.deals === 1 ? '' : 's'} synced
                  {data.hubspot.connection.open_url && <> · <a href={data.hubspot.connection.open_url} target="_blank" rel="noopener noreferrer">Open deals in HubSpot</a></>}
                </div>
                {data.hubspot.connection.status !== 'active' && <div style={{ ...subtle, color: 'var(--red)' }}>{data.hubspot.connection.last_error || 'The connection stopped working.'} Reconnect to switch the sync back on.</div>}
              </div>
              {data.hubspot.connection.status !== 'active' && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={connectHubspot}>Reconnect</button>}
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => { if (await dialogs.confirm('Disconnect HubSpot? Syncing stops and ScopeGov’s access is revoked. Everything already in HubSpot stays there.')) act('/api/workspace/integrations/hubspot', 'DELETE', undefined, 'HubSpot disconnected.') }}>Disconnect</button>
            </div>
            {data.hubspot.rule && (
              <div style={{ marginTop: 8 }}>
                <div className="flbl" style={{ marginBottom: 6 }}>Sync</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                  {Object.entries(data.hubspot.eventLabels).map(([ev, label]) => (
                    <label key={ev} style={{ fontSize: 12 }}>
                      <input type="checkbox" disabled={busy || !canWrite} checked={data.hubspot.rule!.event_types.includes(ev)}
                        onChange={e => act('/api/workspace/integrations/hubspot', 'PATCH', { events: e.target.checked ? [...data.hubspot.rule!.event_types, ev] : data.hubspot.rule!.event_types.filter(x => x !== ev) }, 'Saved.')} /> {label}
                    </label>
                  ))}
                </div>
                <div className="fgrp" style={{ marginBottom: 10 }}>
                  <label className="flbl">Deal pipeline</label>
                  <select className="finp" disabled={busy || !canWrite || data.hubspot.connection.status !== 'active'} value={data.hubspot.rule.pipeline_id || ''} onFocus={loadPipelines}
                    onChange={e => act('/api/workspace/integrations/hubspot', 'PATCH', { pipeline_id: e.target.value }, 'Pipeline saved.')}>
                    {(pipelines || (data.hubspot.rule.pipeline_id ? [{ id: data.hubspot.rule.pipeline_id, label: data.hubspot.rule.pipeline_id === 'default' ? 'Sales Pipeline (default)' : data.hubspot.rule.pipeline_id }] : [])).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                  <div style={subtle}>Won and lost deals use that pipeline’s “Closed won” and “Closed lost” stages.</div>
                </div>
                <label style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                  <input type="checkbox" disabled={busy || !canWrite} checked={data.hubspot.rule.include_amounts}
                    onChange={e => act('/api/workspace/integrations/hubspot', 'PATCH', { include_amounts: e.target.checked }, e.target.checked ? 'Deal amounts will be sent.' : 'Deal amounts will not be sent.')} /> Send the contract value as the deal amount <span style={subtle}>(needs permission to view financials)</span>
                </label>
                <div style={subtle}>
                  {data.hubspot.rule.active ? 'On' : <span style={{ color: 'var(--red)' }}>Off</span>} · last synced {when(data.hubspot.rule.last_success_at)} · {data.hubspot.rule.health.pending} waiting, {data.hubspot.rule.health.dead} skipped or failed
                </div>
                {data.hubspot.rule.disabled_reason && <div style={{ ...subtle, color: 'var(--red)' }}>{data.hubspot.rule.disabled_reason}</div>}
                {data.hubspot.rule.health.last?.error && data.hubspot.rule.health.last.status !== 'succeeded' && <div style={{ ...subtle, color: 'var(--red)' }}>Last problem: {data.hubspot.rule.health.last.error}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !canWrite || data.hubspot.connection.status !== 'active' || !data.hubspot.rule.active} onClick={backfillHubspot}>Sync existing projects</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !canWrite} onClick={() => act('/api/workspace/integrations/hubspot', 'PATCH', { active: !data.hubspot.rule!.active }, data.hubspot.rule!.active ? 'HubSpot sync turned off.' : 'HubSpot sync turned on.')}>{data.hubspot.rule.active ? 'Turn off' : 'Turn on'}</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="settings-section" style={{ marginBottom: 16 }}>
        <div className="settings-section-title">Google Drive</div>
        {!data.drive.allowed ? (
          <div style={subtle}>{data.lapsed ? 'Reactivate your subscription to use Google Drive.' : `Google Drive needs the ${data.nativeMinPlan} plan or above.`}</div>
        ) : !data.drive.configured ? (
          <div style={subtle}>Google Drive is not set up on this server yet. The operator needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see integrations/google-drive/README.md).</div>
        ) : !data.drive.connection ? (
          <>
            <div style={{ ...subtle, marginBottom: 10 }}>
              Keep your own copy of every signed SOW and accepted change order: each is saved as its original signed PDF in your Google Drive, in
              <strong> ScopeGov Archive / Client / Project</strong>. ScopeGov can only see the files and folders it creates there, nothing else in your Drive.
            </div>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !data.encryptionConfigured} onClick={connectDrive}>Connect Google Drive</button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  Connected{data.drive.connection.account_email ? ` as ${data.drive.connection.account_email}` : ''}
                  {data.drive.connection.status !== 'active' && <span style={{ ...subtle, color: 'var(--red)' }}> · needs reconnecting</span>}
                </div>
                <div style={subtle}>
                  {data.drive.archived} document{data.drive.archived === 1 ? '' : 's'} archived
                  {data.drive.connection.folder_url && <> · <a href={data.drive.connection.folder_url} target="_blank" rel="noopener noreferrer">Open the folder</a></>}
                </div>
                {data.drive.connection.status !== 'active' && <div style={{ ...subtle, color: 'var(--red)' }}>{data.drive.connection.last_error || 'The connection stopped working.'} Reconnect to switch archiving back on.</div>}
              </div>
              {data.drive.connection.status !== 'active' && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={connectDrive}>Reconnect</button>}
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => { if (await dialogs.confirm('Disconnect Google Drive? Archiving stops and ScopeGov’s access is revoked. The PDFs already in your Drive stay where they are.')) act('/api/workspace/integrations/google-drive', 'DELETE', undefined, 'Google Drive disconnected.') }}>Disconnect</button>
            </div>
            {data.drive.rule && (
              <div style={{ marginTop: 8 }}>
                <div className="flbl" style={{ marginBottom: 6 }}>Archive</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBottom: 8 }}>
                  {Object.entries(data.drive.eventLabels).map(([ev, label]) => (
                    <label key={ev} style={{ fontSize: 12 }}>
                      <input type="checkbox" disabled={busy || !canWrite} checked={data.drive.rule!.event_types.includes(ev)}
                        onChange={e => act('/api/workspace/integrations/google-drive', 'PATCH', { events: e.target.checked ? [...data.drive.rule!.event_types, ev] : data.drive.rule!.event_types.filter(x => x !== ev) }, 'Saved.')} /> {label}
                    </label>
                  ))}
                </div>
                <div style={subtle}>
                  {data.drive.rule.active ? 'On' : <span style={{ color: 'var(--red)' }}>Off</span>} · last archived {when(data.drive.rule.last_success_at)} · {data.drive.rule.health.pending} waiting, {data.drive.rule.health.dead} skipped or failed
                </div>
                {data.drive.rule.disabled_reason && <div style={{ ...subtle, color: 'var(--red)' }}>{data.drive.rule.disabled_reason}</div>}
                {data.drive.rule.health.last?.error && data.drive.rule.health.last.status !== 'succeeded' && <div style={{ ...subtle, color: 'var(--red)' }}>Last problem: {data.drive.rule.health.last.error}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !canWrite || data.drive.connection.status !== 'active' || !data.drive.rule.active} onClick={backfillDrive}>Archive past documents</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !canWrite} onClick={() => act('/api/workspace/integrations/google-drive', 'PATCH', { active: !data.drive.rule!.active }, data.drive.rule!.active ? 'Archiving turned off.' : 'Archiving turned on.')}>{data.drive.rule.active ? 'Turn off' : 'Turn on'}</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

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

    </div>
  )
}
