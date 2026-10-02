import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('SOW portal terminal states carry agency branding', () => {
  const route = read('app/api/portal/sow/[token]/route.ts')
  const page  = read('app/portal/sow/[token]/page.tsx')

  it('every terminal status in buildSowResponse returns a branding object', () => {
    const body = route.slice(route.indexOf('async function buildSowResponse'))
    for (const st of ['signed', 'withdrawn', 'declined', 'expired', 'changes_requested']) {
      const idx = body.indexOf(`state: '${st}'`)
      expect(idx, st).toBeGreaterThan(-1)
      expect(body.slice(idx, idx + 260), st).toContain('branding: await portalBranding(sow, service)')
    }
  })

  it('the page never interpolates sow?.agencyName directly (undefined on a revisit)', () => {
    expect(page).not.toMatch(/\$\{sow\?\.agencyName\}/)
    expect(page).not.toMatch(/\{sow\?\.agencyName\} has been notified/)
    expect(page).toContain("setBranding(json.branding)")
    expect(page).toContain("agencyLabel ? `The team at ${agencyLabel}` : 'The agency'")
  })
})

describe('SowEditor writes a pending MSA reference on unmount', () => {
  const src = read('components/sow/SowEditor.tsx')
  it('fires a keepalive PATCH instead of only clearing the debounce timer', () => {
    expect(src).toContain('keepalive: true')
    expect(src).not.toMatch(/return \(\) => \{ if \(msaSaveTimer\.current\) clearTimeout\(msaSaveTimer\.current\) \}/)
  })
})

describe('SOW sign route: retry with a superseded token', () => {
  it('answers 409 already-signed rather than 410 no-longer-active', () => {
    const src = read('app/api/portal/sow/[token]/sign/route.ts')
    expect(src).toMatch(/revokedReason === 'superseded'\)\s*\n\s*return NextResponse\.json\(\{ error: 'This SOW was already signed' \}, \{ status: 409 \}\)/)
  })
})
