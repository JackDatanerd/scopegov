// Machine-to-machine callers must use the host that serves the app, not the bare domain that 308-redirects to it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8')

describe('server-to-server URLs use the www host', () => {
  it('the Zapier integration defaults to https://www.scopegov.app', () => {
    expect(read('integrations/zapier/index.js')).toMatch(/SCOPEGOV_API_BASE \|\| 'https:\/\/www\.scopegov\.app'/)
  })
  it('the README points the Resend and Paystack webhooks at www', () => {
    const readme = read('README.md')
    expect(readme).toContain('https://www.scopegov.app/api/guardian/inbound')
    expect(readme).toContain('https://www.scopegov.app/api/billing/webhook')
    expect(readme).not.toMatch(/app\.scopegov\.app\/api\/(guardian\/inbound|billing\/webhook)/)
  })
})
