import { describe, it, expect, beforeAll } from 'vitest'
import * as T from '@/lib/email/templates'
import { __setResendForTests } from '@/lib/email/send'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Notifications & email pass 15: customer-facing copy must match the read-only lapse model
// (no free Solo tier), plural-correct day counts, and the dispute-resolved note must credit the agency.

const sent: Array<{ subject: string; html: string }> = []
beforeAll(() => {
  __setResendForTests({ emails: { send: async (b: any) => { sent.push(b); return { data: { id: 'x' }, error: null } } } } as any)
})
const last = () => sent[sent.length - 1]

describe('pass 15 — lapse copy', () => {
  it('cancellation-scheduled email says read-only, not "moves to the Solo plan"', async () => {
    await T.sendSubscriptionCancelScheduledEmail({ to: 'a@b.com', name: 'N', agencyName: 'Acme', endsAtLabel: '1 Jan 2027', actorName: 'A', manageUrl: 'https://x/y' })
    expect(last().html).toContain('read-only')
    expect(last().html).not.toMatch(/Solo plan/)
  })

  it('payment-failed email says read-only, not downgraded', async () => {
    await T.sendPaymentFailedEmail({ to: 'a@b.com', name: 'N', agencyName: 'Acme', upgradeUrl: 'https://x/y', graceDaysLeft: 3 })
    expect(last().html).toContain('read-only')
    expect(last().html).not.toMatch(/downgrad/i)
  })

  it('payment-failed email is plural-correct for 1 and N days', async () => {
    await T.sendPaymentFailedEmail({ to: 'a@b.com', name: 'N', agencyName: 'Acme', upgradeUrl: 'https://x/y', graceDaysLeft: 1 })
    expect(last().subject).toContain('1 day to resolve')
    expect(last().subject).not.toContain('1 days')
    expect(last().html).toContain('within 1 day,')
    await T.sendPaymentFailedEmail({ to: 'a@b.com', name: 'N', agencyName: 'Acme', upgradeUrl: 'https://x/y', graceDaysLeft: 5 })
    expect(last().subject).toContain('5 days to resolve')
  })

  it('trial warning does not claim editing is already locked while days remain', async () => {
    await T.sendTrialWarningEmail({ to: 'a@b.com', name: 'N', agencyName: 'Acme', daysLeft: 2, upgradeUrl: 'https://x/y' })
    expect(last().html).not.toContain('unlock editing again')
    expect(last().html).toContain('read-only')
    await T.sendTrialWarningEmail({ to: 'a@b.com', name: 'N', agencyName: 'Acme', daysLeft: 0, upgradeUrl: 'https://x/y' })
    expect(last().html).toContain('unlock editing again')
  })

  it('billing settings copy no longer promises a downgrade to Solo', () => {
    const src = readFileSync(join(__dirname, '..', 'components/settings/SettingsClient.tsx'), 'utf8')
    expect(src).not.toContain('will be downgraded to Solo')
    expect(src).not.toContain('then the workspace will be downgraded')
  })
})

describe('pass 15 — dispute resolved email', () => {
  it('attributes the note to the agency, not "Their response"', async () => {
    await T.sendInvoiceDisputeResolvedEmail({
      to: 'c@d.com', clientName: 'Cli', agencyName: 'Acme <Studio>', projectName: 'P',
      invoiceNumber: 'INV-1', note: 'Fixed the rate.', portalUrl: 'https://x/y',
    })
    expect(last().html).not.toContain('Their response')
    expect(last().html).toContain('Response from Acme &lt;Studio&gt;')
  })
})
