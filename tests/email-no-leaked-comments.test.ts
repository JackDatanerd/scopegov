import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { __setResendForTests } from '@/lib/email/send'
import { sendSowSignedClientEmail, sendMfaDisabledEmail } from '@/lib/email/templates'

// Notifications & email pass 19 — B1: a developer note written as an HTML comment inside baseTemplate's template
// literal was sent in the HTML of every outbound email.
describe('outbound email HTML carries no developer notes', () => {
  async function render(send: () => Promise<unknown>) {
    let html = ''
    __setResendForTests({ emails: { send: async (b: any) => { html = b.html; return { data: { id: 'x' }, error: null } } } } as any)
    await send()
    return html
  }

  it('a client-facing email has no prose HTML comments', async () => {
    const html = await render(() => sendSowSignedClientEmail({
      to: 'c@example.com', clientName: 'C', agencyName: 'A', projectName: 'P', portalUrl: 'https://x.test/p',
    }))
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).not.toMatch(/FIX \(/)
    expect(html).not.toMatch(/audit/i)
  })

  it('an internal security email has none either, and still shows its header icon', async () => {
    const html = await render(() => sendMfaDisabledEmail({ to: 'u@example.com', name: 'U', via: 'user' }))
    expect(html).not.toMatch(/FIX \(/)
    expect(html).toContain('🔓')
  })

  it('no HTML comment in templates.ts source carries a FIX/audit note', () => {
    const src = readFileSync(join(__dirname, '../lib/email/templates.ts'), 'utf8')
    const comments = src.match(/<!--[\s\S]*?-->/g) || []
    expect(comments.filter(c => /FIX|audit|pass \d/i.test(c))).toEqual([])
  })
})
