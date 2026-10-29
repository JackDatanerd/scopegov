// lib/integrations/hubspot-sync.ts
//
// One-way sync of a ScopeGov event into the customer's HubSpot CRM:
//
//   client  -> Company (only when the client has a company name) and Contact (only when it has an email)
//   project -> Deal, associated to them; moved to Closed-won when the SOW is signed, Closed-lost when declined
//   events  -> a Note on the deal's timeline (change order accepted, scope flag, payment received, ...)
//
// Properties this is built to keep:
//   • NEVER OVERWRITES THEIR DATA. An existing HubSpot contact (matched by email) or company (matched by exact name) is LINKED to and
//     left exactly as it is. ScopeGov only ever creates records, and only ever edits the deals it created itself.
//   • IDEMPOTENT. integration_external_refs remembers every object made; a retry, duplicate event or repeat backfill is a no-op, and a
//     deal created just before a crash is re-found (same name, created in the last hour) instead of duplicated.
//   • SELF-HEALING. If someone deletes a synced company/contact/deal in HubSpot, the next event recreates it (once).
//   • NO CUSTOM PROPERTIES. Nothing is added to the customer's HubSpot schema (no extra scopes); notes are plain escaped text.
//   • NARROW. Amounts are sent only if the rule's owner chose to (and held VIEW_FINANCIALS); the project must belong to the event's workspace.

import { decryptSecret } from './crypto'
import { dropRef, findRef, saveRef, type RefCtx } from './external-refs'
import { forgetHubspotToken, hubspotAccessToken, classifyHubspot, stagesOf, type HubspotCaller, type HubspotVerdict, type HubspotResponse } from './hubspot'
import { HUBSPOT_API, HUBSPOT_EVENT_PERMISSIONS } from './hubspot-config'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ORPHAN_WINDOW_MS = 60 * 60 * 1000

export interface HubspotSyncInput {
  service: any
  connection: { id: string; workspace_id: string; credentials_enc: string | null }
  rule: { config: { pipeline_id?: string; include_amounts?: boolean } | null }
  event: { id: string; event_type: string; workspace_id: string; project_id: string | null; created_at?: string; data: any }
  call: HubspotCaller
  env?: NodeJS.ProcessEnv
  nowMs?: number
}
export type HubspotSyncOutcome = { verdict: HubspotVerdict; dealId?: string }

class Stop extends Error { constructor(public verdict: HubspotVerdict) { super('stop') } }
class Heal extends Error { constructor(public what: string) { super('heal') } }
const permanent = (error: string): HubspotSyncOutcome => ({ verdict: { outcome: 'permanent', error } })

export const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export function splitName(full: string): { firstname: string; lastname?: string } {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return { firstname: parts[0] || '' }
  return { firstname: parts.slice(0, -1).join(' '), lastname: parts[parts.length - 1] }
}

export async function syncEventToHubspot(i: HubspotSyncInput): Promise<HubspotSyncOutcome> {
  const env = i.env || process.env, now = i.nowMs ?? Date.now()
  const type = i.event.event_type
  if (!(type in HUBSPOT_EVENT_PERMISSIONS)) return permanent(`HubSpot does not act on ${type}.`)
  if (!i.event.project_id || !UUID.test(i.event.project_id)) return permanent('This event has no project.')

  // 1. The project and its client: must be this workspace's, and alive.
  const { data: project, error: pErr } = await i.service.from('projects')
    .select('id, workspace_id, name, status, contract_value, currency, client_id, deleted_at, clients(id, name, company_name, email, phone)')
    .eq('id', i.event.project_id).maybeSingle()
  if (pErr) return { verdict: { outcome: 'retry', error: `Could not read the project: ${pErr.message}` } }
  if (!project || project.workspace_id !== i.event.workspace_id) return permanent('The project no longer exists.')
  if (project.deleted_at) return permanent('The project was deleted.')
  const client = project.clients || null
  const includeAmounts = i.rule.config?.include_amounts === true
  const pipelineId = i.rule.config?.pipeline_id || 'default'

  // 2. HubSpot access.
  let refresh: string
  try { refresh = JSON.parse(decryptSecret(i.connection.credentials_enc || '', `${i.connection.workspace_id}:${i.connection.id}`)).refresh_token } catch {
    return { verdict: { outcome: 'connection_off', error: 'Stored HubSpot token unreadable', reason: 'The stored HubSpot connection could not be read. Reconnect HubSpot.' } }
  }
  if (!refresh) return { verdict: { outcome: 'connection_off', error: 'No HubSpot refresh token', reason: 'Reconnect HubSpot.' } }
  const tok = await hubspotAccessToken(i.connection.id, refresh, i.call, env, now)
  if (!tok.ok) return { verdict: tok.verdict }
  const auth = { token: tok.token }
  const refs: RefCtx = { service: i.service, connection: i.connection }

  // One call to HubSpot. A 401 (the 30-minute token expired early) is retried ONCE with a fresh token.
  const api = async (method: HubspotRequestMethod, path: string, json?: unknown): Promise<{ v: HubspotVerdict; json: any }> => {
    const send = () => i.call({ method, url: `${HUBSPOT_API}${path}`, headers: { Authorization: `Bearer ${auth.token}` }, json })
    let res: HubspotResponse
    try { res = await send() } catch (e: any) {
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      return { v: { outcome: 'retry', error: timeout ? 'HubSpot did not answer in time.' : `Could not reach HubSpot: ${e?.message || e}` }, json: null }
    }
    if (res.status === 401) {
      forgetHubspotToken(i.connection.id)
      const t = await hubspotAccessToken(i.connection.id, refresh, i.call, env, now)
      if (t.ok) { auth.token = t.token; try { res = await send() } catch (e: any) { return { v: { outcome: 'retry', error: `Could not reach HubSpot: ${e?.message || e}` }, json: null } } }
    }
    return { v: classifyHubspot(res), json: res.json }
  }
  /** Unwrap a successful answer or abort the whole sync with its verdict. `healKey` marks a 404 as "the thing we remembered is gone". */
  const must = (r: { v: HubspotVerdict; json: any }, healKey?: string) => {
    if (r.v.outcome === 'ok') return r.json
    if (r.v.outcome === 'not_found' && healKey) throw new Heal(healKey)
    throw new Stop(r.v)
  }

  try {
    // 3. The pipeline's stages (open / won / lost), from HubSpot's own metadata.
    const pr = await api('GET', `/crm/v3/pipelines/deals/${encodeURIComponent(pipelineId)}`)
    if (pr.v.outcome === 'not_found') return { verdict: { outcome: 'rule_off', error: 'HubSpot pipeline not found', reason: 'The selected HubSpot deal pipeline no longer exists. Choose a pipeline again, then turn this back on.' } }
    const stages = stagesOf(must(pr))
    const wantStage = type === 'sow.declined' ? 'lost' : 'won'
    const stageId = stages[wantStage]
    if (!stageId) return { verdict: { outcome: 'rule_off', error: `Pipeline "${stages.label}" has no Closed ${wantStage} stage`, reason: `The selected HubSpot pipeline has no "Closed ${wantStage}" stage. Choose another pipeline, then turn this back on.` } }

    // Each heal drops ONE stale record (deal, company or contact), so at most three heals can be needed in a run (all three deleted in HubSpot).
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const ids = await syncRecords({ i, api, must, refs, project, client, stageId, includeAmounts, pipelineId, type, now })
        return { verdict: { outcome: 'ok' }, dealId: ids.dealId }
      } catch (e) {
        if (e instanceof Heal && attempt < 3) { await healRefs(refs, project.id, client?.id, e.what); continue }
        if (e instanceof Heal) return { verdict: { outcome: 'retry', error: 'A synced HubSpot record keeps disappearing; will try again.' } }
        throw e
      }
    }
    return { verdict: { outcome: 'retry', error: 'HubSpot sync did not complete.' } }
  } catch (e) {
    if (e instanceof Stop) return { verdict: e.verdict }
    return { verdict: { outcome: 'retry', error: `HubSpot sync failed: ${(e as Error)?.message || e}` } }
  }
}

type HubspotRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
type Api = (m: HubspotRequestMethod, path: string, json?: unknown) => Promise<{ v: HubspotVerdict; json: any }>
type Must = (r: { v: HubspotVerdict; json: any }, healKey?: string) => any

async function healRefs(refs: RefCtx, projectId: string, clientId: string | undefined, what: string) {
  if (what === 'deal') await dropRef(refs, 'deal', `deal:${projectId}`)
  if (what === 'company' && clientId) await dropRef(refs, 'company', `company:${clientId}`)
  if (what === 'contact' && clientId) await dropRef(refs, 'contact', `contact:${clientId}`)
}

async function syncRecords(a: { i: HubspotSyncInput; api: Api; must: Must; refs: RefCtx; project: any; client: any; stageId: string; includeAmounts: boolean; pipelineId: string; type: string; now: number }) {
  const { i, api, must, refs, project, client, stageId, includeAmounts, pipelineId, type, now } = a
  let companyId: string | null = null, contactId: string | null = null, linkContact = false
  // "Fresh" = created or adopted in THIS run. A fresh company/contact must be (re)linked to the deal even if the deal already exists
  // (e.g. the company was deleted in HubSpot and rebuilt while the deal survived).
  let freshCompany = false, freshContact = false, dealCreated = false

  // ── Company: link to an existing one (exact name) or create. Never edited. ──
  const companyName = client?.company_name ? String(client.company_name).trim() : ''
  if (client && companyName) {
    const known = await findRef(refs, 'company', `company:${client.id}`)
    if (known) companyId = known.remote_id
    else {
      const found = must(await api('POST', '/crm/v3/objects/companies/search', {
        filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: companyName }] }],
        sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }], limit: 1, properties: ['name'],
      }))
      companyId = found?.results?.[0]?.id ?? null
      if (!companyId) companyId = must(await api('POST', '/crm/v3/objects/companies', { properties: { name: companyName } }))?.id ?? null
      if (!companyId) throw new Stop({ outcome: 'retry', error: 'HubSpot returned no company id.' })
      await saveRef(refs, 'company', `company:${client.id}`, companyId, companyName)
      linkContact = true; freshCompany = true
    }
  }

  // ── Contact: link to an existing one (same email) or create. Never edited. ──
  const email = client?.email ? String(client.email).trim().toLowerCase() : ''
  if (client && email) {
    const known = await findRef(refs, 'contact', `contact:${client.id}`)
    if (known) contactId = known.remote_id
    else {
      const search = async () => must(await api('POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], limit: 1, properties: ['email'] }))?.results?.[0]?.id ?? null
      contactId = await search()
      if (!contactId) {
        const n = splitName(client.name)
        const made = await api('POST', '/crm/v3/objects/contacts', { properties: { email, firstname: n.firstname, ...(n.lastname ? { lastname: n.lastname } : {}), ...(client.phone ? { phone: String(client.phone) } : {}) } })
        if (made.v.outcome === 'retry' && /conflict/i.test((made.v as any).error)) contactId = await search() // created by someone else a moment ago
        else contactId = must(made)?.id ?? null
      }
      if (!contactId) throw new Stop({ outcome: 'retry', error: 'HubSpot returned no contact id.' })
      await saveRef(refs, 'contact', `contact:${client.id}`, contactId, client.name || email)
      linkContact = true; freshContact = true
    }
  }
  if (companyId && contactId && linkContact) must(await api('PUT', `/crm/v4/objects/contacts/${contactId}/associations/default/companies/${companyId}`), 'company')

  // ── Deal: ONE per project. Created at the stage the event implies; only deals we made are ever edited. ──
  const amount = includeAmounts && project.contract_value !== null && project.contract_value !== undefined && Number.isFinite(Number(project.contract_value)) ? String(Number(project.contract_value)) : null
  const closeDate = type === 'sow.signed' || type === 'sow.declined' ? (i.event.created_at && !Number.isNaN(Date.parse(i.event.created_at)) ? new Date(i.event.created_at).toISOString() : new Date(now).toISOString()) : null
  const stageEvent = type === 'sow.signed' || type === 'sow.declined'
  let dealId: string | null = (await findRef(refs, 'deal', `deal:${project.id}`))?.remote_id ?? null

  if (dealId) {
    const patch: Record<string, string> = {}
    if (stageEvent) { patch.pipeline = pipelineId; patch.dealstage = stageId; if (closeDate) patch.closedate = closeDate }
    if (amount !== null && (stageEvent || type === 'change_order.accepted')) patch.amount = amount // the contract value after amendments
    if (Object.keys(patch).length) must(await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties: patch }), 'deal')
  } else {
    // A deal made just before a crash (never recorded) is adopted, not duplicated.
    const orphan = must(await api('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [
        { propertyName: 'dealname', operator: 'EQ', value: project.name },
        { propertyName: 'createdate', operator: 'GTE', value: String(now - ORPHAN_WINDOW_MS) },
      ] }], sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }], limit: 1, properties: ['dealname'],
    }))?.results?.[0]?.id ?? null
    const properties: Record<string, string> = {
      dealname: String(project.name), pipeline: pipelineId, dealstage: stageId,
      description: clip(`ScopeGov project${client?.name ? ` for ${client.name}` : ''}. Status: ${project.status}.`, 500),
      ...(amount !== null ? { amount } : {}), ...(closeDate ? { closedate: closeDate } : {}),
    }
    if (orphan) { dealId = orphan; if (stageEvent) must(await api('PATCH', `/crm/v3/objects/deals/${dealId}`, { properties }), 'deal') }
    else dealId = must(await api('POST', '/crm/v3/objects/deals', { properties }))?.id ?? null
    if (!dealId) throw new Stop({ outcome: 'retry', error: 'HubSpot returned no deal id.' })
    await saveRef(refs, 'deal', `deal:${project.id}`, dealId, String(project.name))
    dealCreated = true
  }
  if (companyId && (dealCreated || freshCompany)) must(await api('PUT', `/crm/v4/objects/deals/${dealId}/associations/default/companies/${companyId}`), 'company')
  if (contactId && (dealCreated || freshContact)) must(await api('PUT', `/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`), 'contact')

  // ── Timeline note (not for backfilled history: that would be noise). One per event, ever. ──
  if (!i.event.data?.backfill && !(await findRef(refs, 'note', `note:${i.event.id}`))) {
    const d = i.event.data || {}
    const lines = [`<strong>${esc(clip(String(d.title || type), 200))}</strong>`]
    if (d.summary) lines.push(esc(clip(String(d.summary), 600)))
    if (d.signed_by) lines.push(`Signed by: ${esc(clip(String(d.signed_by), 100))}`)
    if (d.accepted_by) lines.push(`Accepted by: ${esc(clip(String(d.accepted_by), 100))}`)
    if (d.payment?.method) lines.push(`Method: ${esc(clip(String(d.payment.method), 40))}`)
    const quote = d.reason || d.feedback
    if (quote) lines.push(`“${esc(clip(String(quote), 500))}”`)
    lines.push('<em>via ScopeGov</em>')
    const note = must(await api('POST', '/crm/v3/objects/notes', { properties: { hs_note_body: clip(lines.join('<br>'), 2000), hs_timestamp: new Date(i.event.created_at && !Number.isNaN(Date.parse(i.event.created_at)) ? i.event.created_at : now).toISOString() } }))
    if (!note?.id) throw new Stop({ outcome: 'retry', error: 'HubSpot returned no note id.' })
    await saveRef(refs, 'note', `note:${i.event.id}`, note.id, null)
    must(await api('PUT', `/crm/v4/objects/notes/${note.id}/associations/default/deals/${dealId}`), 'deal')
  }
  return { dealId }
}
