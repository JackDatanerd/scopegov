import { describe, it, expect } from 'vitest'
import {
  extractUnquotedContent, isForwardSubject, cleanSubject, isAutomatedMessage, senderEmail, matchGuardianAddress,
} from '@/lib/ai/guardian-email'

// The inbound webhook used to filter quoted text line-by-line: it dropped only the marker line of an
// Outlook reply (leaving the whole quoted thread to be re-classified as a NEW request) and missed
// Gmail's attribution line when the client wrapped it over two lines.
describe('extractUnquotedContent', () => {
  it('cuts an Outlook-style reply at the marker instead of keeping the quoted thread', () => {
    const t = 'Sounds good, please also add a loyalty programme.\n\n-----Original Message-----\nFrom: Jane <j@a.com>\nSent: Monday\nTo: Us\nSubject: Re: kickoff\n\nWe need a blog for the site and a mobile app.\n'
    expect(extractUnquotedContent(t)).toBe('Sounds good, please also add a loyalty programme.')
  })

  it('cuts at a Gmail attribution line wrapped over two lines', () => {
    const t = 'Add SSO please.\n\nOn Mon, Sep 21, 2026 at 10:15 AM Jane Mwangi <jane@acme.example.com>\nwrote:\n\nOld thread text about a mobile app'
    expect(extractUnquotedContent(t)).toBe('Add SSO please.')
  })

  it('cuts at a single-line attribution and drops > quoted lines', () => {
    expect(extractUnquotedContent('Add SSO please.\n\nOn Mon, Sep 21, 2026 at 10:15 AM Jane <j@a.com> wrote:\n> old')).toBe('Add SSO please.')
    expect(extractUnquotedContent('New ask\n> quoted\nmore new')).toBe('New ask\nmore new')
  })

  it('cuts at the Outlook underscore rule', () => {
    expect(extractUnquotedContent('New ask: add a blog.\n\n________________________________\nFrom: Jane\nSent: Monday\nSubject: x\n\nold text')).toBe('New ask: add a blog.')
  })

  it('keeps a FORWARDED client message (the documented workflow) but drops its header block', () => {
    const outlook = 'FYI\n\n-----Original Message-----\nFrom: Jane <j@a.com>\nSent: Monday\nTo: Us\nSubject: FW: kickoff\n\nCan you also build a mobile app?'
    expect(extractUnquotedContent(outlook, { isForward: true })).toBe('FYI\n\nCan you also build a mobile app?')
    const gmail = '---------- Forwarded message ---------\nFrom: Jane <j@a.com>\nDate: Mon\nSubject: Hi\nTo: me\n\nPlease add a Swahili version.\n\nOn Sun, Jane wrote:\n> older'
    expect(extractUnquotedContent(gmail)).toBe('Please add a Swahili version.')
  })

  it('does not delete legitimate lines that merely start with "From:" or "---"', () => {
    expect(extractUnquotedContent('From: my side, we need SSO.\n--- and a blog too')).toBe('From: my side, we need SSO.\n--- and a blog too')
  })

  it('stops at the signature delimiter', () => {
    expect(extractUnquotedContent('Add SSO.\n-- \nJane\nAcme')).toBe('Add SSO.')
  })
})

describe('subjects', () => {
  it('recognises forwards and strips reply chains', () => {
    expect(isForwardSubject('Fwd: quote')).toBe(true)
    expect(isForwardSubject('FW: quote')).toBe(true)
    expect(isForwardSubject('Re: quote')).toBe(false)
    expect(cleanSubject('Re: Fwd: RE: Add a blog')).toBe('Add a blog')
  })
})

describe('isAutomatedMessage', () => {
  it('flags auto-responders, bulk mail and bounces', () => {
    expect(isAutomatedMessage({ Headers: [{ Name: 'Auto-Submitted', Value: 'auto-replied' }] })).toBe(true)
    expect(isAutomatedMessage({ Headers: [{ Name: 'Precedence', Value: 'bulk' }] })).toBe(true)
    expect(isAutomatedMessage({ From: 'MAILER-DAEMON@mx.example.com' })).toBe(true)
  })
  it('lets a normal message and Auto-Submitted: no through', () => {
    expect(isAutomatedMessage({ Headers: [{ Name: 'Auto-Submitted', Value: 'no' }], From: 'jane@acme.com' })).toBe(false)
    expect(isAutomatedMessage({})).toBe(false)
  })
})

describe('senderEmail / matchGuardianAddress', () => {
  it('extracts a lower-cased sender', () => {
    expect(senderEmail({ FromFull: { Email: 'Jane@Acme.com' } })).toBe('jane@acme.com')
    expect(senderEmail({ From: 'Jane <JANE@acme.com>' })).toBe('jane@acme.com')
  })
  it('matches the WHOLE guardian address only', () => {
    expect(matchGuardianAddress('Jane <proj-ab12cd34@guard.scopegov.app>', 'guard.scopegov.app')).toBe('ab12cd34')
    expect(matchGuardianAddress('evilproj-ab12cd34@guard.scopegov.app', 'guard.scopegov.app')).toBeNull()
    expect(matchGuardianAddress('proj-ab12cd34@guard.scopegov.app.evil.com', 'guard.scopegov.app')).toBeNull()
  })
})
