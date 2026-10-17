import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hydrateSections } from '@/lib/sow/sections'
import { renderSowPdf } from '@/lib/pdf/renderer'

// A long Deliverables table that starts low on page 1 must move to the next page whole. It used to be squashed into the space left,
// drawn over itself and past the footer, with the rows after the first group missing from the PDF altogether. tests/sow-table-layout.test.ts
// guards the structure; this renders real PDFs and checks that no row is lost, which is the symptom that mattered.
const ROWS = [
  ['Access to Solvane TikTok and Instagram accounts', 'Client grants the Provider the account access needed to publish content', 'Client', 'November 1, 2026'],
  ['View-only analytics and traffic data access', 'Client grants view-only access to the analytics and traffic data needed for the monthly report, or a regular export of it; this is not administration of any store or system', 'Client', 'November 1, 2026'],
  ['Initial raw UGC footage', 'Client supplies the initial raw UGC footage from which posts are produced', 'Client', 'November 13, 2026'],
  ['Short-form posts (6 per week combined across TikTok and Instagram Reels)', 'Six posts published each week across TikTok and Instagram Reels, produced from raw UGC footage supplied by the Client', 'Provider', 'Weekly'],
  ['Caption writing', 'A caption written for each published post', 'Provider', 'Weekly'],
  ['Trend research', 'Ongoing research of trends relevant to the Solvane presence, used to inform post content', 'Provider', 'Weekly'],
  ['Hashtag strategy', 'A set of hashtags selected for each published post', 'Provider', 'Weekly'],
  ['Basic video cuts and captions', 'Basic cuts and on-screen captions applied to each post', 'Provider', 'Weekly'],
  ['Monthly analytics report with traffic data', 'A monthly report tracking follower growth and social-referral traffic, with traffic data; these measures are reported and not guaranteed', 'Provider', 'Monthly'],
].map(([deliverable, acceptanceCriteria, owner, targetDate]) => ({ deliverable, acceptanceCriteria, owner, targetDate }))
const MARKERS = ['Access to Solvane', 'View-only analytics', 'Initial raw UGC', 'Short-form posts (6', 'Caption writing', 'Trend research', 'Hashtag strategy', 'Basic video cuts', 'Monthly analytics report with']
const OVERVIEW = ['Objective. The Provider will manage the TikTok and Instagram Reels accounts of the Client\u2019s Solvane brand with trend-responsive short-form content, in order to build brand awareness and drive traffic to the Client\u2019s Shopify store. Follower growth and social-referral traffic are tracked and reported monthly as measures of performance; they are not guaranteed.',
  'What is delivered. Each month the Provider will publish 6 posts per week combined across TikTok and Instagram Reels, using raw UGC footage supplied by the Client.'].map(t => `<p>${t}</p>`).join('')

const hasPdftotext = !spawnSync('pdftotext', ['-v']).error

// Needs poppler's pdftotext on the PATH (present in CI and on Linux/macOS dev machines); skipped where it is not installed.
describe.skipIf(!hasPdftotext)('every deliverable row survives wherever the table starts on the page', () => {
  // Pushing the table down by 0..12 extra lines walks its first group across the page boundary. Several of these positions lost rows.
  it.each([0, 2, 4, 6, 7, 9, 10, 12])('table pushed down by %i lines: all 9 rows, once each, in order', async (extra) => {
    const secs = hydrateSections([], { language: 'en', paymentStructure: 'monthly' }).map((s: any) => {
      if (s.id === 'deliverables') s.table = ROWS
      else if (s.id === 'overview') s.content = OVERVIEW + Array.from({ length: extra + 3 }, () => '<p>Extra line of body text to push the table down the page a little bit more.</p>').join('')
      else if (!['timeline', 'roles', 'payment_schedule'].includes(s.id)) s.content = `<p>Body ${s.id}</p>`
      return s
    })
    const buf = await renderSowPdf({ agencyName: 'A', clientName: 'B', projectName: 'P', contractValue: 1200, currency: 'USD', language: 'en', version: 1, isWatermarked: false, paymentStructure: 'monthly', paymentSchedule: [], sections: secs } as any)
    const dir = mkdtempSync(join(tmpdir(), 'sowpdf-'))
    try {
      const file = join(dir, 'sow.pdf')
      writeFileSync(file, Buffer.from(buf))
      const text = spawnSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8' }).stdout
      const positions = MARKERS.map(m => { expect(text.split(m).length - 1, `row "${m}" appears once`).toBe(1); return text.indexOf(m) })
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 60000)
})
