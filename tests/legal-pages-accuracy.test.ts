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
    for (const name of ['Supabase', 'Vercel', 'Anthropic', 'OpenAI', 'Resend', 'Postmark', 'Paystack', 'Google', 'Cloudflare', 'jsDelivr']) {
      expect(privacy, name).toContain(name)
    }
  })

  it('.env.local.example carries no stale brand domains', () => {
    expect(read('.env.local.example')).not.toMatch(/bastionhq/i)
  })
})
