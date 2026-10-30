// ScopeGov for Zapier. Every trigger is a REST hook: when a Zap is switched on Zapier POSTs the Zap's URL to ScopeGov
// (/api/integrations/v1/hooks), ScopeGov calls it for each matching event, and switching the Zap off deletes the hook.
//
// The trigger list is generated from the server's event catalog (events.json — `node
// --experimental-strip-types scripts/gen-zapier-events.mjs` from the repo root), so a new event needs no edits here.

const events = require('./events.json')
const { version } = require('./package.json')

// MUST be the host that serves the app directly. https://scopegov.app answers every request with a 308 to https://www.scopegov.app,
// and an HTTP client drops the Authorization header when a redirect crosses hosts, so an apex base would reject every API key.
const BASE = process.env.SCOPEGOV_API_BASE || 'https://www.scopegov.app'

const withApiKey = (request, z, bundle) => {
  request.headers = request.headers || {}
  request.headers.Authorization = `Bearer ${bundle.authData.apiKey}`
  return request
}

const raiseForAuth = (response, z) => {
  if (response.status === 401) throw new z.errors.Error('That API key was not accepted. Create a new one in ScopeGov under Settings → Integrations.', 'AuthenticationError', 401)
  return response
}

const trigger = e => ({
  key: e.type.replace(/\./g, '_'),
  noun: e.label.replace(/ (Signed|Declined|Expired|Stalled|Accepted|Countered|Sent|Paid|Overdue|Disputed|Raised|Ending|Claimed)$/, ''),
  display: { label: e.label, description: e.description },
  operation: {
    type: 'hook',
    performSubscribe: (z, bundle) => z.request({
      url: `${BASE}/api/integrations/v1/hooks`, method: 'POST',
      body: { target_url: bundle.targetUrl, event: e.type },
    }).then(r => r.data),
    // Whatever performSubscribe returned is stored as bundle.subscribeData.
    performUnsubscribe: (z, bundle) => z.request({
      url: `${BASE}/api/integrations/v1/hooks/${bundle.subscribeData.id}`, method: 'DELETE',
    }).then(r => r.data),
    perform: (z, bundle) => [bundle.cleanedRequest],
    performList: (z) => z.request({ url: `${BASE}/api/integrations/v1/events/${e.type}/sample` }).then(r => r.data),
    sample: e.sample,
  },
})

module.exports = {
  version,
  platformVersion: require('zapier-platform-core').version,
  authentication: {
    type: 'custom',
    fields: [{ key: 'apiKey', label: 'API key', type: 'password', required: true, helpText: 'Create one in ScopeGov under Settings → Integrations → API keys.' }],
    test: { url: `${BASE}/api/integrations/v1/me` },
    connectionLabel: '{{workspace.name}}',
  },
  beforeRequest: [withApiKey],
  afterResponse: [raiseForAuth],
  triggers: Object.fromEntries(events.map(e => { const t = trigger(e); return [t.key, t] })),
}
