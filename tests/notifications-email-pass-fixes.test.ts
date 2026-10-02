import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ sent: [] as any[] }))
vi.mock('@/lib/email/send', () => ({
  sendEmail: async (p: any) => { h.sent.push(p); return { ok: true, id: 'x' } },
}))

import { sendSowSignedAgencyEmail } from '@/lib/email/templates'

describe('sendSowSignedAgencyEmail link', () => {
  beforeEach(() => { h.sent.length = 0; process.env.NEXT_PUBLIC_APP_URL = 'https://app.test' })

  it('links to the project SOW tab when projectId is given', async () => {
    await sendSowSignedAgencyEmail({ to: ['a@b.co'], agencyName: 'A', clientName: 'C', projectName: 'P', signedBy: 'S', portalUrl: 'https://app.test/other', projectId: 'p1' })
    expect(h.sent[0].html).toContain('https://app.test/projects/p1?tab=sow')
  })

  it('falls back to portalUrl (the deep link the sign route passes) instead of dropping the button', async () => {
    await sendSowSignedAgencyEmail({ to: ['a@b.co'], agencyName: 'A', clientName: 'C', projectName: 'P', signedBy: 'S', portalUrl: 'https://app.test/projects/p2?tab=sow' })
    expect(h.sent[0].html).toContain('Open project in ScopeGov')
    expect(h.sent[0].html).toContain('https://app.test/projects/p2?tab=sow')
  })
})
