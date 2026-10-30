// In-memory stand-in for the parts of HubSpot's OAuth + CRM v3/v4 API the sync uses. Faithful where it matters: EQ/GTE search filters, a
// 409 when a contact's email already exists, deal-stage validation against the pipeline, 404 for a missing object (incl. on
// associations), access tokens that can be rejected once, and the error shapes HubSpot returns ({status, message, category}).
import type { HubspotCaller, HubspotRequest, HubspotResponse } from '@/lib/integrations/hubspot'
import { HUBSPOT_SCOPES } from '@/lib/integrations/hubspot-config'

type ObjType = 'companies' | 'contacts' | 'deals' | 'notes'
export interface HsObject { id: string; properties: Record<string, any>; createdAt: number }

export const PIPELINE = {
  id: 'default', label: 'Sales Pipeline',
  stages: [
    { id: 'appointmentscheduled', label: 'Appointment scheduled', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.2' } },
    { id: 'contractsent', label: 'Contract sent', displayOrder: 1, metadata: { isClosed: 'false', probability: '0.8' } },
    { id: 'closedwon', label: 'Closed won', displayOrder: 2, metadata: { isClosed: 'true', probability: '1.0' } },
    { id: 'closedlost', label: 'Closed lost', displayOrder: 3, metadata: { isClosed: 'true', probability: '0.0' } },
  ],
}

export class FakeHubspot {
  store: Record<ObjType, Map<string, HsObject>> = { companies: new Map(), contacts: new Map(), deals: new Map(), notes: new Map() }
  associations: Array<{ from: string; fromId: string; to: string; toId: string }> = []
  pipelines: any[] = [PIPELINE]
  calls: HubspotRequest[] = []
  oauthCalls: HubspotRequest[] = []
  tokensIssued = 0
  revoked: string[] = []
  seq = 100
  clock = 1_800_000_000_000
  // failure switches
  tokenError: string | null = null
  reject401 = 0
  rateLimited = 0
  serverError = 0
  missingScopes = false
  racingContact: { email: string; id: string } | null = null // another process creates this contact between our search and our create
  exchange: any = null
  tokenInfo: any = { hub_id: 4242, hub_domain: 'agency.hubspot.test', user: 'ada@agency.com', scopes: [...HUBSPOT_SCOPES] }

  private ok = (json: any, status = 200): HubspotResponse => ({ status, json, retryAfter: null })
  private err = (status: number, category: string, message: string): HubspotResponse => ({ status, json: { status: 'error', message, category, correlationId: 'c-1' }, retryAfter: null })

  call: HubspotCaller = async (req) => {
    this.calls.push(req)
    const url = new URL(req.url), p = url.pathname
    // OAuth API 2026-03. The deprecated v1 endpoints are REJECTED here, so a test fails if the code ever calls one.
    if (p.startsWith('/oauth/v1/')) return { status: 410, json: { status: 'error', message: 'OAuth v1 is deprecated', error: 'unsupported_version' }, retryAfter: null }
    this.oauthCalls.push(req)
    if (/[?&](client_secret|token|refresh_token|code)=/.test(url.search) || /\/token\/[^/]+$/.test(p) && !/\/(introspect|revoke)$/.test(p)) return this.err(400, 'BAD_REQUEST', 'sensitive values must be in the request body, not the URL')
    if (p === '/oauth/2026-03/token' && req.method === 'POST') {
      if (req.form?.grant_type === 'authorization_code') return this.exchange ? this.ok(this.exchange) : { status: 400, json: { error: 'invalid_grant', error_description: 'bad code', status: 'BAD_AUTH_CODE' }, retryAfter: null }
      if (this.tokenError) return { status: 400, json: { error: 'invalid_grant', error_description: 'refresh token is invalid, expired or revoked', status: this.tokenError, message: 'refresh token is invalid, expired or revoked' }, retryAfter: null }
      return this.ok({ access_token: `hs-at-${++this.tokensIssued}`, refresh_token: req.form?.refresh_token, expires_in: 1800 })
    }
    if (p === '/oauth/2026-03/token/introspect' && req.method === 'POST') {
      if (!req.form?.client_id || !req.form?.client_secret || !req.form?.token || !req.form?.token_type_hint) return this.err(400, 'BAD_REQUEST', 'missing introspect fields')
      return this.tokenInfo ? this.ok({ active: true, token_use: 'access_token', ...this.tokenInfo }) : this.err(404, 'NOT_FOUND', 'token not found')
    }
    if (p === '/oauth/2026-03/token/revoke' && req.method === 'POST') { this.revoked.push(String(req.form?.token || '')); return this.ok({}, 204) }
    if (p.startsWith('/oauth/')) return this.err(404, 'NOT_FOUND', `unknown oauth path ${p}`)

    if (this.serverError > 0) { this.serverError--; return this.ok({}, 503) }
    if (this.rateLimited > 0) { this.rateLimited--; return this.err(429, 'RATE_LIMITS', 'You have reached your secondly limit.') }
    if (this.missingScopes) return this.err(403, 'MISSING_SCOPES', 'This app hasn\'t been granted all required scopes to make this call.')
    if (this.reject401 > 0) { this.reject401--; return this.err(401, 'EXPIRED_AUTHENTICATION', 'Authentication credentials not found.') }
    if (!/^Bearer hs-at-\d+$/.test(req.headers?.Authorization || '') && !p.startsWith('/crm/v3/pipelines')) return this.err(401, 'INVALID_AUTHENTICATION', 'bad token')

    // pipelines
    if (req.method === 'GET' && p === '/crm/v3/pipelines/deals') return this.ok({ results: this.pipelines })
    const pl = /^\/crm\/v3\/pipelines\/deals\/([^/]+)$/.exec(p)
    if (req.method === 'GET' && pl) { const f = this.pipelines.find(x => x.id === decodeURIComponent(pl[1])); return f ? this.ok(f) : this.err(404, 'OBJECT_NOT_FOUND', 'pipeline not found') }

    // search
    const search = /^\/crm\/v3\/objects\/(companies|contacts|deals)\/search$/.exec(p)
    if (req.method === 'POST' && search) {
      const body: any = req.json, type = search[1] as ObjType
      const hits = [...this.store[type].values()].filter(o => (body.filterGroups || []).some((g: any) => g.filters.every((f: any) => {
        const v = f.propertyName === 'createdate' ? o.createdAt : o.properties[f.propertyName]
        if (f.operator === 'EQ') return String(v ?? '').toLowerCase() === String(f.value).toLowerCase()
        if (f.operator === 'GTE') return Number(v) >= Number(f.value)
        return false
      })))
      const dir = body.sorts?.[0]?.direction === 'DESCENDING' ? -1 : 1
      hits.sort((a, b) => dir * (a.createdAt - b.createdAt))
      return this.ok({ total: hits.length, results: hits.slice(0, body.limit || 10).map(h => ({ id: h.id, properties: h.properties })) })
    }
    // create
    const create = /^\/crm\/v3\/objects\/(companies|contacts|deals|notes)$/.exec(p)
    if (req.method === 'POST' && create) {
      const type = create[1] as ObjType, props = { ...(req.json as any).properties }
      if (type === 'contacts') {
        if (this.racingContact && props.email === this.racingContact.email) {
          this.add('contacts', { email: props.email, firstname: 'Existing' }, this.racingContact.id); this.racingContact = null
          return this.err(409, 'CONFLICT', `Contact already exists. Existing ID: ${[...this.store.contacts.keys()].pop()}`)
        }
        if ([...this.store.contacts.values()].some(c => String(c.properties.email).toLowerCase() === String(props.email).toLowerCase()))
          return this.err(409, 'CONFLICT', 'Contact already exists.')
      }
      if (type === 'deals') {
        const pipe = this.pipelines.find(x => x.id === props.pipeline)
        if (!pipe || !pipe.stages.some((s: any) => s.id === props.dealstage)) return this.err(400, 'VALIDATION_ERROR', `${props.dealstage} is not a valid dealstage for pipeline ${props.pipeline}`)
      }
      const o = this.add(type, props); return this.ok({ id: o.id, properties: o.properties }, 201)
    }
    // update
    const upd = /^\/crm\/v3\/objects\/(companies|contacts|deals)\/([^/]+)$/.exec(p)
    if (req.method === 'PATCH' && upd) {
      const o = this.store[upd[1] as ObjType].get(upd[2]); if (!o) return this.err(404, 'OBJECT_NOT_FOUND', 'not found')
      Object.assign(o.properties, (req.json as any).properties); return this.ok({ id: o.id, properties: o.properties })
    }
    // associations (v4 default label)
    const assoc = /^\/crm\/v4\/objects\/(\w+)\/([^/]+)\/associations\/default\/(\w+)\/([^/]+)$/.exec(p)
    if (req.method === 'PUT' && assoc) {
      const [, from, fromId, to, toId] = assoc
      if (!this.store[from as ObjType]?.has(fromId) || !this.store[to as ObjType]?.has(toId)) return this.err(404, 'OBJECT_NOT_FOUND', 'object not found')
      if (!this.associations.some(a => a.from === from && a.fromId === fromId && a.to === to && a.toId === toId)) this.associations.push({ from, fromId, to, toId })
      return this.ok({ status: 'COMPLETE' })
    }
    return this.err(400, 'BAD_REQUEST', `unhandled ${req.method} ${p}`)
  }

  add(type: ObjType, properties: Record<string, any>, id?: string, createdAt?: number): HsObject {
    const o = { id: id ?? String(++this.seq), properties, createdAt: createdAt ?? this.clock }
    this.store[type].set(o.id, o); return o
  }
  remove(type: ObjType, id: string) { this.store[type].delete(id) }
  list(type: ObjType) { return [...this.store[type].values()] }
  linked(from: string, fromId: string, to: string, toId: string) { return this.associations.some(a => a.from === from && a.fromId === fromId && a.to === to && a.toId === toId) }
  writes() { return this.calls.filter(c => c.method !== 'GET' && !c.url.includes('/search') && !c.url.includes('/oauth/')) }
  customerDataWrites() { return this.calls.filter(c => (c.method === 'PATCH' || c.method === 'DELETE') && /\/objects\/(contacts|companies)\//.test(c.url)) }
}
