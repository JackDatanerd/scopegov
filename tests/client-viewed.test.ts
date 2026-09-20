import { describe, it, expect, vi } from 'vitest'

const notify = vi.fn()
vi.mock('@/lib/utils/notify', () => ({ notifyMembersWithPermission: (...a: any[]) => notify(...a) }))

import { looksLikeLinkScanner, markFirstViewed } from '@/lib/utils/client-viewed'

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const SAFARI_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'

describe('looksLikeLinkScanner', () => {
  it('lets real browsers through', () => {
    for (const ua of [CHROME, SAFARI_IOS, FIREFOX]) expect(looksLikeLinkScanner(ua)).toBe(false)
  })
  it('flags mail-gateway, preview and script clients — they would report "opened" seconds after every send', () => {
    for (const ua of [
      'Slackbot-LinkExpanding 1.0', 'WhatsApp/2.23', 'facebookexternalhit/1.1', 'Mozilla/5.0 (compatible; Googlebot/2.1)',
      'curl/8.4.0', 'python-requests/2.31', 'Go-http-client/2.0', 'Mozilla/5.0 (Windows NT 10.0) HeadlessChrome/120',
      'Mozilla/4.0 (compatible; ms-office; MSOffice 16)', 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)',
    ]) expect(looksLikeLinkScanner(ua)).toBe(true)
  })
  it('treats a missing User-Agent as a script', () => {
    expect(looksLikeLinkScanner(null)).toBe(true)
    expect(looksLikeLinkScanner('')).toBe(true)
    expect(looksLikeLinkScanner('   ')).toBe(true)
  })
})

function fakeService(returned: any[] | null, error: any = null) {
  const calls: any[] = []
  const chain: any = {
    update: (v: any) => { calls.push(['update', v]); return chain },
    eq: (...a: any[]) => { calls.push(['eq', ...a]); return chain },
    is: (...a: any[]) => { calls.push(['is', ...a]); return chain },
    select: async () => ({ data: returned, error }),
  }
  return { calls, service: { from: (t: string) => { calls.push(['from', t]); return chain } } }
}
const base = { kind: 'sow' as const, id: 's1', workspaceId: 'w1', projectId: 'p1', projectName: 'Site', clientName: 'Acme', userAgent: CHROME }

describe('markFirstViewed', () => {
  it('stamps with a guarded update and notifies exactly the SOW senders', async () => {
    notify.mockClear()
    const { service, calls } = fakeService([{ id: 's1' }])
    await markFirstViewed(service, base)
    expect(calls).toContainEqual(['is', 'first_viewed_at', null])
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][1]).toMatchObject({ permission: 'SEND_SOW', eventType: 'client_viewed', type: 'sow_viewed', projectId: 'p1' })
  })
  it('does not notify when another request already stamped it (no row returned)', async () => {
    notify.mockClear()
    const { service } = fakeService([])
    await markFirstViewed(service, base)
    expect(notify).not.toHaveBeenCalled()
  })
  it('does neither stamp nor notify for a link scanner', async () => {
    notify.mockClear()
    const { service, calls } = fakeService([{ id: 's1' }])
    await markFirstViewed(service, { ...base, userAgent: 'Slackbot-LinkExpanding 1.0' })
    expect(calls).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })
  it('a database error never throws and never notifies', async () => {
    notify.mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { service } = fakeService(null, { message: 'boom' })
    await expect(markFirstViewed(service, base)).resolves.toBeUndefined()
    expect(notify).not.toHaveBeenCalled()
  })
  it('routes CO and invoice views to their own permission', async () => {
    notify.mockClear()
    await markFirstViewed(fakeService([{ id: 'x' }]).service, { ...base, kind: 'co' })
    await markFirstViewed(fakeService([{ id: 'x' }]).service, { ...base, kind: 'invoice' })
    expect(notify.mock.calls[0][1]).toMatchObject({ permission: 'SEND_CHANGE_ORDERS', type: 'co_viewed' })
    expect(notify.mock.calls[1][1]).toMatchObject({ permission: 'VIEW_FINANCIALS', type: 'invoice_viewed' })
  })
})
