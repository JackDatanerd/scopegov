import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveSignerTitle } from '@/lib/documents/signer-title'
import { renderInvoicePdf } from '@/lib/pdf/renderer'

const read = (p: string) => readFileSync(p, 'utf8')

describe('signer title on the signature block', () => {
  const metadata = { clientRepresentative: 'Faith Christine', clientRepresentativeTitle: 'Director' }
  it('what the signer typed always wins', () => {
    expect(resolveSignerTitle({ entered: 'Founder', signerName: 'Faith Christine', metadata })).toBe('Founder')
  })
  it('a blank box takes the position the agreement already names, for that person', () => {
    expect(resolveSignerTitle({ entered: '', signerName: 'Faith Christine', metadata })).toBe('Director')
    expect(resolveSignerTitle({ entered: null, signerName: '  faith   christine ', metadata })).toBe('Director')
  })
  it('never gives a colleague signing in her place her title', () => {
    expect(resolveSignerTitle({ entered: '', signerName: 'Jo Ng', metadata })).toBeNull()
  })
  it('is null when the agreement names no position', () => {
    expect(resolveSignerTitle({ entered: '', signerName: 'Faith Christine', metadata: { clientRepresentative: 'Faith Christine' } })).toBeNull()
    expect(resolveSignerTitle({ entered: '', signerName: 'Faith Christine', metadata: null })).toBeNull()
  })
  it('the sign route stores the resolved title, so every later PDF carries it', () => {
    const src = read('app/api/portal/sow/[token]/sign/route.ts')
    expect(src).toContain('resolveSignerTitle({ entered: signerTitleEntered, signerName, metadata: sow.metadata })')
    expect(src).toContain('signer_title:   signerTitle,')
  })
})

describe('amounts use the embedded font', () => {
  it('the renderer no longer asks for the non-embedded Courier for amounts', () => {
    const src = read('lib/pdf/renderer.tsx')
    expect(src).not.toContain("'Courier'")
    expect(src).not.toContain("'Courier-Bold'")
  })
  it('a rendered invoice embeds only its own fonts', async () => {
    const buf = await renderInvoicePdf({
      agencyName: 'Burnett Specialists', logoUrl: null, brandColour: '#5568b8', clientName: 'DTC Skincare', projectName: 'Socials',
      title: 'Month 1', amount: 649.5, amountPaid: 0, currency: 'USD', status: 'awaiting', payments: [],
    } as any)
    const text = buf.toString('latin1')
    expect(text.slice(0, 5)).toBe('%PDF-')
    expect(text).not.toContain('Courier')
  }, 60_000)
})

describe('change order drafting is bounded', () => {
  const src = read('app/api/co/draft/route.ts')
  it('asks for limits, an explicit amendment of the exclusion, and who bears third-party costs', () => {
    expect(src).toContain('Bound every line item')
    expect(src).toContain('brings it into scope by amending that exclusion')
    expect(src).toContain('Costs paid to third parties')
  })
  it('knows when the project is a retainer and what that means for timeline and fees', () => {
    expect(src).toContain("project.type === 'retainer'")
    expect(src).toContain('one-time fee or recurs monthly')
    expect(src).toContain('leave timelineImpactDays null')
  })
})
