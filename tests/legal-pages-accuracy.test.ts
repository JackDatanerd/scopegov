import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { GRACE_DAYS, TRIAL_DAYS } from '@/lib/billing/plans'
import { TERMS_VERSION, TERMS_VERSION_PATTERN } from '@/lib/auth/terms'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const pages = ['terms', 'privacy', 'dpa', 'security', 'cookies'].map(n => ({ n, src: read(`app/legal/${n}/page.tsx`) }))

describe('legal pages — publish-ready and consistent with the code', () => {
  it('no unfilled placeholders or internal-review banners remain', () => {
    for (const { n, src } of pages) {
      expect(src, `${n} placeholder`).not.toMatch(/styles\.placeholder|\[DATE OF PUBLICATION\]/)
      expect(src, `${n} reviewNote`).not.toContain('styles.reviewNote')
      expect(src, `${n} draft banner`).not.toContain('Draft for internal review')
    }
  })

  it('terms version is a valid label for the current text', () => {
    expect(TERMS_VERSION).toBe('2026-10')
    expect(TERMS_VERSION_PATTERN.test(TERMS_VERSION)).toBe(true)
  })

  it('security page does not claim HTTP-only session cookies (the browser client writes them via document.cookie)', () => {
    expect(read('app/legal/security/page.tsx')).not.toMatch(/HTTP-only/i)
    expect(read('lib/supabase/client.ts')).toContain('document.cookie')
  })

  it('terms state the trial length and grace window the code actually uses', () => {
    const terms = read('app/legal/terms/page.tsx')
    expect(terms).toContain(`${TRIAL_DAYS}-day free trial`)
    expect(terms).toContain(`${GRACE_DAYS}-day grace period`)
  })

  it('privacy retention figures match the purge code', () => {
    const privacy = read('app/legal/privacy/page.tsx')
    const restore = /RESTORE_WINDOW_DAYS\s*=\s*(\d+)/.exec(read('app/api/workspace/restore/route.ts'))
    expect(restore && Number(restore[1])).toBe(30)
    expect(privacy).toContain('restore a deleted workspace for 30 days')
    expect(read('app/api/cron/workspace-purge/route.ts')).toContain('getUTCFullYear() - 7')
    expect(privacy).toContain('7 years from the deletion date')
    expect(read('app/api/cron/project-purge/route.ts')).toContain('30 * 86400000')
    expect(privacy).toContain('30 days after deletion')
    const cleanup = read('app/api/cron/notification-cleanup/route.ts')
    expect(cleanup).toMatch(/READ_RETENTION_DAYS\s*=\s*90/)
    expect(cleanup).toMatch(/ANY_RETENTION_DAYS\s*=\s*180/)
    expect(privacy).toContain('after 90 days')
    expect(privacy).toContain('after 180 days')
  })

  it('every cookie the code sets is on the cookie page', () => {
    const cookies = read('app/legal/cookies/page.tsx')
    expect(read('middleware.ts')).toContain("'ss_ref'")
    expect(cookies).toContain('ss_ref')
    expect(cookies).toContain('-code-verifier')
  })

  it('subprocessors for services the code actually calls are listed', () => {
    const privacy = read('app/legal/privacy/page.tsx')
    for (const name of ['Supabase', 'Vercel', 'Anthropic', 'OpenAI', 'Resend', 'Postmark', 'Paystack', 'Google', 'Cloudflare']) {
      expect(privacy, name).toContain(name)
    }
  })

  it('.env.local.example carries no stale brand domains', () => {
    expect(read('.env.local.example')).not.toMatch(/bastionhq/i)
  })
  it('fonts and icons are self-hosted: no Google Fonts / jsDelivr request, so none needs disclosing', () => {
    for (const f of ['app/layout.tsx', 'styles/globals.css']) {
      expect(read(f), f).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net/)
    }
    expect(read('app/layout.tsx')).toContain("@fontsource/ibm-plex-sans/400.css")
    expect(read('app/layout.tsx')).toContain("@tabler/icons-webfont/dist/tabler-icons.min.css")
    expect(read('app/legal/privacy/page.tsx')).not.toContain('jsDelivr')
    expect(read('app/legal/cookies/page.tsx')).not.toContain('jsDelivr')
  })

  it('privacy states the real data location and the signing record', () => {
    const privacy = read('app/legal/privacy/page.tsx')
    expect(privacy).toContain('European Union (Ireland)')
    expect(privacy).toContain('IP address and browser details')
    expect(read('app/api/portal/sow/[token]/sign/route.ts')).toContain('signer_ip')
  })

  it('every signer-facing portal shell links the Privacy Policy and Terms', () => {
    expect(read('components/portal/PortalLegalFooter.tsx')).toContain('/legal/privacy')
    expect(read('components/portal/PortalLegalFooter.tsx')).toContain('/legal/terms')
    expect(read('components/portal/PortalShell.tsx')).toContain('<PortalLegalFooter />')
    expect(read('app/portal/sow/[token]/page.tsx')).toContain('<PortalLegalFooter />')
  })

  it('cookie page: ss_ref is not called strictly necessary; session cookie lifetime matches the library default', () => {
    const cookies = read('app/legal/cookies/page.tsx')
    expect(cookies).not.toMatch(/ss_ref<\/code><\/td>[\s\S]{0,400}Strictly necessary/)
    expect(cookies).toContain('Up to 400 days')
    expect(read('node_modules/@supabase/ssr/dist/main/utils/constants.js')).toMatch(/maxAge:\s*400 \* 24 \* 60 \* 60/)
    expect(read('lib/supabase/cookie-options.ts')).not.toContain('maxAge')
  })

  it('terms/DPA wording matches the product: no owner-configurable MFA, no unconditional Solo fallback, no phantom export tool', () => {
    const terms = read('app/legal/terms/page.tsx')
    const dpa = read('app/legal/dpa/page.tsx')
    expect(terms).not.toMatch(/whether\s+two-factor/)
    expect(terms).not.toMatch(/moves to\s+the Solo plan/)
    expect(dpa).not.toContain('listed above')
    expect(dpa).not.toContain('export and deletion tools built into')
    expect(dpa).not.toContain('row-level\n          database access control per workspace')
    expect(dpa).toContain('instruct us in writing')
    expect(read('app/api/clients/[id]/contacts/[contactId]/route.ts')).toContain('export async function DELETE')
  })
})
