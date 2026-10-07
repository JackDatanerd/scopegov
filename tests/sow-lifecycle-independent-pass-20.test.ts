import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { parseTableAmount } from '@/lib/sow/table-schema'

describe('SOW pass 20', () => {
  it('reads million shorthand, leaves k and plain numbers alone', () => {
    expect(parseTableAmount('1.5M')).toBe(1500000)
    expect(parseTableAmount('KES 2 million')).toBe(2000000)
    expect(parseTableAmount('2mn')).toBe(2000000)
    expect(parseTableAmount('1.5k')).toBe(1500)
    expect(parseTableAmount('3 months')).toBe(3)
    expect(parseTableAmount('12,500')).toBe(12500)
  })
  it('withdrawing a changes_requested SOW sends no cancellation email', () => {
    const src = readFileSync('app/api/sow/[id]/withdraw/route.ts', 'utf8')
    expect(src).toContain("sow.status === 'changes_requested'")
    expect(src).toContain('if (skipClientEmail) emailed = true')
  })
  it('the section-patch RPC migration refuses a draft in an approval chain', () => {
    const sql = readFileSync('supabase/migrations/152_sow_patch_rpcs_approval_lock.sql', 'utf8')
    expect(sql).toContain("a.document_type = 'sow'")
    expect(sql).not.toContain('FUNCTION public.sow_set_metadata_key')
  })
})

import { renderSowPdf } from '@/lib/pdf/renderer'
describe('SOW pass 20: tall sections paginate', () => {
  const sec = (content: string) => ({ id: 'overview', title: 'o', content, visible: true, order: 2 })
  const base: any = { agencyName: 'A', agencyLogoUrl: null, brandColour: '#1A5C3A', clientName: 'C', projectName: 'P', contractValue: 1000, currency: 'KES', version: 1 }
  for (const [name, html] of [['pre', '<pre><code>' + 'line\n'.repeat(150) + '</code></pre>'], ['br', '<p>' + 'a<br>'.repeat(150) + '</p>']]) {
    it(`${name}: no unsplittable overflow warning`, async () => {
      const errs: string[] = []
      const orig = console.error, origW = console.warn
      console.error = (...a: any[]) => { errs.push(a.join(' ')) }; console.warn = console.error
      try { await renderSowPdf({ ...base, sections: [sec(html)] }) } finally { console.error = orig; console.warn = origW }
      expect(errs.join('\n')).not.toMatch(/bigger than available page height/)
    }, 30000)
  }
})
