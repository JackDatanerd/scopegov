import { describe, it, expect, beforeEach } from 'vitest'
import { __setResendForTests } from '@/lib/email/send'
import { sendSowSignedAgencyEmail, sendSowSignedClientEmail, sendCoAcceptedClientEmail } from '@/lib/email/templates'
import { announceNotificationsChanged, notificationsChangedSource, NOTIFICATIONS_CHANGED_EVENT } from '@/lib/utils/notification-links'

let sent: any[] = []
beforeEach(() => {
  sent = []
  __setResendForTests({ emails: { send: async (b: any) => { sent.push(b); return { data: { id: 'x' }, error: null } } } } as any)
})
const att = [{ filename: 'a.pdf', content: 'QQ==' }]

describe('signed-confirmation emails only claim an attachment when there is one', () => {
  it('SOW signed (agency)', async () => {
    const base = { to: ['a@b.com'], agencyName: 'A', clientName: 'C', projectName: 'P', signedBy: 'S', portalUrl: 'https://x/y' }
    await sendSowSignedAgencyEmail({ ...base, attachments: att })
    await sendSowSignedAgencyEmail(base)
    expect(sent[0].html).toContain('has been attached')
    expect(sent[1].html).not.toContain('has been attached')
    expect(sent[1].html).toContain('could not be attached')
  })
  it('SOW signed (client)', async () => {
    const base = { to: 'c@d.com', clientName: 'C', agencyName: 'A', projectName: 'P', portalUrl: 'https://x/y' }
    await sendSowSignedClientEmail({ ...base, attachments: att })
    await sendSowSignedClientEmail(base)
    expect(sent[0].html).toContain('PDF copy is attached')
    expect(sent[1].html).not.toContain('is attached')
    expect(sent[1].html).toContain('download a PDF copy')
  })
  it('CO accepted (client)', async () => {
    const base = { to: 'c@d.com', clientName: 'C', agencyName: 'A', projectName: 'P', coTitle: 'T', total: 10, currency: 'USD', portalUrl: 'https://x/y' }
    await sendCoAcceptedClientEmail({ ...base, attachments: att })
    await sendCoAcceptedClientEmail(base)
    expect(sent[0].html).toContain('PDF copy is attached')
    expect(sent[1].html).not.toContain('is attached')
  })
})

describe('notifications-changed event carries its source', () => {
  it('reports who announced it', () => {
    const seen: Array<string | undefined> = []
    const target = new EventTarget()
    ;(globalThis as any).window = { dispatchEvent: (e: Event) => target.dispatchEvent(e) }
    target.addEventListener(NOTIFICATIONS_CHANGED_EVENT, e => seen.push(notificationsChangedSource(e)))
    announceNotificationsChanged('bell')
    announceNotificationsChanged('inbox')
    announceNotificationsChanged()
    delete (globalThis as any).window
    expect(seen).toEqual(['bell', 'inbox', undefined])
  })
})
