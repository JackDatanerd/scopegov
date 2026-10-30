// Guardian inbound via Resend Receiving (replaces the Postmark webhook).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  parseReceivedEvent, recipientHeader, verifyInboundSignature, fetchReceivedEmail, listReceivedAttachments,
  downloadReceivedAttachment, parseAuthentication, senderFailedAuthentication, headersToList, bareAddress, toSenderView,
  InboundFetchError,
} from '@/lib/email/resend-inbound'
import { isAutomatedMessage, senderEmail, matchGuardianAddress } from '@/lib/ai/guardian-email'

const SECRET_RAW = 'inbound-test-secret'
const SECRET = 'whsec_' + Buffer.from(SECRET_RAW).toString('base64')
function sign(body: string, id = 'msg_1', ts = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', Buffer.from(SECRET_RAW)).update(`${id}.${ts}.${body}`).digest('base64')
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` }
}
const hdrs = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('parseReceivedEvent', () => {
  const good = { type: 'email.received', created_at: '2026-10-26T10:00:00Z', data: { email_id: 'e1', from: 'a@b.com', to: ['proj-ab12cd34@guard.scopegov.app'], cc: null, bcc: [], received_for: ['x@y.com'], subject: 'Hi' } }
  it('parses a well-formed event and tolerates null arrays', () => {
    const ev = parseReceivedEvent(good)!
    expect(ev.emailId).toBe('e1'); expect(ev.cc).toEqual([]); expect(ev.to).toHaveLength(1); expect(ev.eventAtMs).toBeGreaterThan(0)
  })
  it('rejects other event types and events without an email id', () => {
    expect(parseReceivedEvent({ ...good, type: 'email.delivered' })).toBeNull()
    expect(parseReceivedEvent({ type: 'email.received', data: {} })).toBeNull()
    expect(parseReceivedEvent(null)).toBeNull()
  })
  it('recipientHeader lists to, cc, bcc, then received_for so a BCC\'d guard address still matches', () => {
    const ev = parseReceivedEvent({ ...good, data: { ...good.data, to: ['client@x.com'], bcc: ['proj-ab12cd34@guard.scopegov.app'] } })!
    expect(matchGuardianAddress(recipientHeader(ev), 'guard.scopegov.app')).toBe('ab12cd34')
  })
  it('to wins over a Received-for clause that names another project', () => {
    const ev = parseReceivedEvent({ ...good, data: { ...good.data, to: ['proj-aaaa1111@guard.scopegov.app'], received_for: ['proj-bbbb2222@guard.scopegov.app'] } })!
    expect(matchGuardianAddress(recipientHeader(ev), 'guard.scopegov.app')).toBe('aaaa1111')
  })
})

describe('verifyInboundSignature (Svix)', () => {
  const body = '{"type":"email.received"}'
  it('accepts a correctly signed request', () => expect(verifyInboundSignature(body, hdrs(sign(body)), SECRET)).toBe(true))
  it('rejects a tampered body, a wrong secret, a stale timestamp and a missing secret', () => {
    expect(verifyInboundSignature(body + ' ', hdrs(sign(body)), SECRET)).toBe(false)
    expect(verifyInboundSignature(body, hdrs(sign(body)), 'whsec_' + Buffer.from('other').toString('base64'))).toBe(false)
    expect(verifyInboundSignature(body, hdrs(sign(body, 'm', Math.floor(Date.now() / 1000) - 3600)), SECRET)).toBe(false)
    expect(verifyInboundSignature(body, hdrs(sign(body)), undefined)).toBe(false)
  })
})

describe('sender view feeds the existing helpers', () => {
  const ev = { from: 'jane@acme.com' }
  it('lower-cased header map -> isAutomatedMessage / senderEmail', () => {
    const plain = toSenderView(ev, { headers: { from: 'Jane <jane@acme.com>' } })
    expect(isAutomatedMessage(plain)).toBe(false)
    expect(senderEmail(plain)).toBe('jane@acme.com')
    expect(plain.From).toBe('Jane <jane@acme.com>')
    expect(isAutomatedMessage(toSenderView(ev, { headers: { 'auto-submitted': 'auto-replied' } }))).toBe(true)
    expect(isAutomatedMessage(toSenderView(ev, { headers: { precedence: 'bulk' } }))).toBe(true)
    expect(isAutomatedMessage(toSenderView({ from: 'MAILER-DAEMON@x.com' }, { headers: {} }))).toBe(true)
  })
  it('bareAddress and headersToList', () => {
    expect(bareAddress('Jane <Jane@Acme.com>')).toBe('Jane@Acme.com'); expect(bareAddress('a@b.com')).toBe('a@b.com')
    expect(headersToList({ a: 'b' })).toEqual([{ Name: 'a', Value: 'b' }])
  })
})

describe('authentication', () => {
  it('parses, defaults unknown values, and only DMARC fail counts as failed', () => {
    expect(parseAuthentication({ spf: 'pass', dkim: 'weird', dmarc: 'fail' })).toEqual({ spf: 'pass', dkim: 'unknown', dmarc: 'fail' })
    expect(parseAuthentication(null)).toBeNull()
    expect(senderFailedAuthentication(parseAuthentication({ spf: 'pass', dkim: 'pass', dmarc: 'fail' }))).toBe(true)
    expect(senderFailedAuthentication(parseAuthentication({ spf: 'fail', dkim: 'gray', dmarc: 'gray' }))).toBe(false)
    expect(senderFailedAuthentication(null)).toBe(false)
  })
})

describe('Resend REST calls', () => {
  const realFetch = global.fetch
  beforeEach(() => { process.env.RESEND_INBOUND_API_KEY = 're_inbound' })
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks() })

  it('fetchReceivedEmail asks for html_format=cid, authenticates with the inbound key, and lower-cases headers', async () => {
    const f = vi.fn(async () => json({ text: 'hello', html: null, headers: { From: 'A <a@b.com>', 'Auto-Submitted': 'no' }, message_id: '<m@x>', authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' }, attachments: [{ id: 'a' }] }))
    global.fetch = f as any
    const r = await fetchReceivedEmail('e/1')
    const [url, init] = f.mock.calls[0] as any
    expect(url).toBe('https://api.resend.com/emails/receiving/e%2F1?html_format=cid')
    expect(init.headers.Authorization).toBe('Bearer re_inbound')
    expect(r.headers.from).toBe('A <a@b.com>'); expect(r.html).toBe(''); expect(r.attachmentCount).toBe(1); expect(r.rfcMessageId).toBe('<m@x>')
  })
  it('a non-2xx, a network failure and a missing key all throw InboundFetchError (route answers 500)', async () => {
    global.fetch = vi.fn(async () => json({}, 404)) as any
    await expect(fetchReceivedEmail('e1')).rejects.toMatchObject({ status: 404 })
    global.fetch = vi.fn(async () => { throw new Error('boom') }) as any
    await expect(fetchReceivedEmail('e1')).rejects.toBeInstanceOf(InboundFetchError)
    delete process.env.RESEND_INBOUND_API_KEY
    await expect(fetchReceivedEmail('e1')).rejects.toBeInstanceOf(InboundFetchError)
  })
  it('listReceivedAttachments keeps only well-formed rows', async () => {
    global.fetch = vi.fn(async () => json({ data: [{ id: 'a', filename: 'x.pdf', content_type: 'application/pdf', size: 5, download_url: 'https://d/x' }, { id: 'b' }, null] })) as any
    expect(await listReceivedAttachments('e1')).toEqual([{ id: 'a', filename: 'x.pdf', contentType: 'application/pdf', size: 5, downloadUrl: 'https://d/x' }])
  })
  const file = (o: any = {}) => ({ id: 'a', filename: 'x.pdf', contentType: 'application/pdf', size: 10, downloadUrl: 'https://files.example/x', ...o })
  it('downloadReceivedAttachment: skips oversize before fetching, refuses non-https, never sends the API key', async () => {
    const f = vi.fn(async () => new Response(Buffer.from('%PDF-1.4'))); global.fetch = f as any
    expect(await downloadReceivedAttachment(file({ size: 99 }), 50)).toBeNull(); expect(f).not.toHaveBeenCalled()
    await expect(downloadReceivedAttachment(file({ downloadUrl: 'http://files.example/x' }), 50)).rejects.toBeInstanceOf(InboundFetchError)
    const buf = await downloadReceivedAttachment(file(), 50)
    expect(buf!.toString()).toBe('%PDF-1.4')
    expect((f.mock.calls[0] as any)[1].headers).toBeUndefined()
  })
  it('downloadReceivedAttachment: retries one 5xx, gives up on a 4xx, and rejects bytes over the cap', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response(Buffer.from('ok')))
    global.fetch = f as any
    expect((await downloadReceivedAttachment(file(), 50))!.toString()).toBe('ok'); expect(f).toHaveBeenCalledTimes(2)
    const g = vi.fn(async () => new Response('', { status: 403 })); global.fetch = g as any
    await expect(downloadReceivedAttachment(file(), 50)).rejects.toBeInstanceOf(InboundFetchError); expect(g).toHaveBeenCalledTimes(1)
    global.fetch = vi.fn(async () => new Response(Buffer.alloc(100))) as any
    expect(await downloadReceivedAttachment(file({ size: 0 }), 50)).toBeNull()
  })
})

describe('route wiring', () => {
  const src = readFileSync('app/api/guardian/inbound/route.ts', 'utf8')
  it('no longer reads Postmark fields or env', () => {
    expect(src).not.toMatch(/POSTMARK|payload\.|StrippedTextReply|OriginalRecipient/)
  })
  it('fetches the message only after the cheap database filters', () => {
    const fetchAt = src.indexOf('await fetchReceivedEmail(')
    for (const marker of ["'No matching project'", "'Already processed'", "'Project paused — email not checked'"])
      expect(src.indexOf(marker), marker).toBeLessThan(fetchAt)
  })
  it('the inbound webhook has its own secret, not the delivery webhook\'s', () => {
    expect(src).toContain('process.env.RESEND_INBOUND_WEBHOOK_SECRET'); expect(src).not.toMatch(/process\.env\.RESEND_WEBHOOK_SECRET/)
  })
})
