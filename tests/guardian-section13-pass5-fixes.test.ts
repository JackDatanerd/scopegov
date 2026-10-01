import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { toPlainText } from '@/lib/ai/guardian'
import { extractUnquotedContent } from '@/lib/ai/guardian-email'

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('B1 — forwarder signature above the forwarded message', () => {
  it('keeps the forwarded client request (Outlook header block) after a "--" signature', () => {
    const t = 'FYI see below\n\n--\nBob Smith\nAcme\n\nFrom: Client <c@x.com>\nSent: Monday\nTo: me\nSubject: hi\n\nPlease add dark mode'
    const out = extractUnquotedContent(t, { isForward: true })
    expect(out).toContain('FYI see below')
    expect(out).toContain('Please add dark mode')
    expect(out).not.toContain('Bob Smith')
    expect(out).not.toContain('Sent:')
  })
  it('keeps a Gmail-style forwarded banner body after a "--" signature', () => {
    const t = 'See below\n-- \nBob\n\n---------- Forwarded message ---------\nFrom: Client <c@x.com>\nDate: Mon\nSubject: hi\nTo: me\n\nCan you add SSO?'
    const out = extractUnquotedContent(t, { isForward: true })
    expect(out).toContain('Can you add SSO?')
    expect(out).not.toContain('Bob')
  })
  it('keeps a ">"-quoted forwarded body after a "--" signature', () => {
    const out = extractUnquotedContent('Look at this\n--\nBob\n\n> Please add a Spanish version', { isForward: true })
    expect(out).toContain('Please add a Spanish version')
    expect(out).not.toContain('Bob')
  })
  it('still stops at the CLIENT signature once the forwarded body is under way', () => {
    const t = 'FYI\n\nFrom: Client\nSent: Monday\nTo: me\nSubject: hi\n\nPlease add dark mode\n\n--\nClient Name\nFrom: Old\nSent: Sunday\n\nearlier thread text'
    const out = extractUnquotedContent(t, { isForward: true })
    expect(out).toContain('Please add dark mode')
    expect(out).not.toContain('earlier thread text')
    expect(out).not.toContain('Client Name')
  })
  it('a plain reply is unchanged: signature ends the scan', () => {
    expect(extractUnquotedContent('Hi,\nplease add dark mode.\n\nThanks\n--\nBob\nAcme')).toBe('Hi,\nplease add dark mode.\n\nThanks')
  })
  it('a forward with a signature and nothing after it still ends at the signature', () => {
    expect(extractUnquotedContent('Cover note\n--\nBob', { isForward: true })).toBe('Cover note')
  })
})

describe('L2 — Outlook HTML noise', () => {
  const html = '<html><head><!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--><style>p{margin:0}</style></head>'
    + '<body><p class=MsoNormal>Hi team,<o:p></o:p></p><p class=MsoNormal><o:p>&nbsp;</o:p></p><p class=MsoNormal>Can we add a Spanish version?<o:p></o:p></p></body></html>'
  it('strips conditional comments and namespaced tags', () => {
    const out = toPlainText(html)
    expect(out).not.toMatch(/[<>]/)
    expect(out).not.toContain('OfficeDocumentSettings')
    expect(out).toContain('Hi team,')
    expect(out).toContain('Can we add a Spanish version?')
  })
  it('does not treat angle-bracketed addresses/URLs as tags', () => {
    const out = toPlainText('<p>Mail <mailto:jane@acme.com> or see <http://acme.com/x></p>')
    expect(out).toContain('<mailto:jane@acme.com>')
    expect(out).toContain('<http://acme.com/x>')
  })
  it('leaves an unclosed comment as written and stays fast on pathological input', () => {
    expect(toPlainText('<p>hi</p> <!-- never closed')).toContain('<!-- never closed')
    const t0 = Date.now()
    toPlainText('<p>' + '<!-- x '.repeat(50000))
    expect(Date.now() - t0).toBeLessThan(1500)
  })
})

describe('B2 / L1 — source wiring', () => {
  it('project completion closes flags with a resolution, per status, with a status CAS', () => {
    const src = read('app/api/projects/[id]/complete/route.ts')
    expect(src).toContain("closeGroup('open', 'closed')")
    expect(src).toContain("closeGroup('borderline_review', 'not_out_of_scope')")
    expect(src).toContain('.in(\'id\', ids).eq(\'status\', status)')
    expect(src).toContain('resolved_by:  session.id')
  })
  it('inbound resolves octet-stream attachment types from the extension', () => {
    const src = read('app/api/guardian/inbound/route.ts')
    expect(src).toContain('resolveAttachmentType(name,')
  })
})
