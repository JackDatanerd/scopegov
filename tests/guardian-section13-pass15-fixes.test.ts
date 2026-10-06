import { describe, it, expect } from 'vitest'
import { extractUnquotedContent } from '../lib/ai/guardian-email'

describe('B1: one-line "On ... wrote:" needs a date/address hint to cut a reply', () => {
  it('keeps a request that follows a prose line ending in "wrote:"', () => {
    const out = extractUnquotedContent(`Hi Bob,

On the kickoff call your colleague Sarah wrote:
"we will do three rounds of revisions"

We now need five rounds, plus a mobile app.`)
    expect(out).toContain('five rounds, plus a mobile app')
  })
  it('still cuts a genuine Gmail / Apple Mail attribution', () => {
    expect(extractUnquotedContent('Add dark mode please.\n\nOn Sep 1, 2026, Bob Smith wrote:\n> old')).toBe('Add dark mode please.')
    expect(extractUnquotedContent('Add dark mode.\n\nOn Mon, Sep 1, 2026 at 10:00 AM Bob <bob@a.com> wrote:\n> old')).toBe('Add dark mode.')
  })
})

describe('B1: abbreviated attribution followed by quoted text still cuts', () => {
  it('cuts "On Sun, Jane wrote:" when the next line is quoted', () => {
    expect(extractUnquotedContent('Please add a Swahili version.\n\nOn Sun, Jane wrote:\n> older')).toBe('Please add a Swahili version.')
  })
})
