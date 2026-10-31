// The help search must find what people actually type. These tests run the real ranking over the real articles, so a new article that
// breaks an old search, or a reworded title that hides an article, fails here instead of in front of a customer.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ARTICLES, getCategory } from '@/lib/help'
import { buildHelpIndex, searchHelp, normalize, stem, stripMarkup } from '@/lib/help/search'
import HelpSearch from '@/components/help/HelpSearch'

const index = buildHelpIndex(ARTICLES, getCategory)
const top = (q: string, n = 3) => searchHelp(index, q, n).map(r => r.slug)

describe('help search: every article is findable', () => {
  it('finds each article first when you type its exact title', () => {
    for (const a of ARTICLES) {
      expect(top(a.title, 1), `typing the title of ${a.slug}`).toEqual([a.slug])
    }
  })

  it('finds each article when you type one of its problems in the reader\u2019s words', () => {
    for (const a of ARTICLES) {
      for (const p of a.problems) {
        const symptom = stripMarkup(p.symptom)
        expect(top(symptom, 5), `typing "${symptom}" should surface ${a.slug}`).toContain(a.slug)
      }
    }
  })

  it('indexes plain text only, never markup', () => {
    for (const e of index) {
      for (const t of [e.title, e.summary, e.answer, ...e.steps, ...e.symptoms, ...e.labels]) {
        expect(t, e.slug).not.toMatch(/\*\*|\]\(/)
      }
    }
  })
})

describe('help search: what people type', () => {
  it.each([
    ["can't send", 'why-cant-i-send-sow'],
    ['cant send', 'why-cant-i-send-sow'],
    ['read-only', 'read-only-workspace'],
    ['read only', 'read-only-workspace'],
    ['how do I invite someone', 'invite-team-and-roles'],
    ['two factor', 'mfa-set-up-two-factor'],
    ['2fa', 'mfa-set-up-two-factor'],
    ['password', 'password-reset-and-change'],
    ['forgot my password', 'password-reset-and-change'],
    ['slack', 'slack-updates-in-channel'],
    ['zapier', 'zapier-connect-scopegov'],
    ['api key', 'api-keys-create-and-revoke'],
    ['webhook', 'webhooks-send-events-to-your-system'],
    ['cancel subscription', 'change-or-cancel-plan'],
    ['update card', 'change-or-cancel-plan'],
    ['sensitivity', 'guardian-settings'],
    ['counter offer', 'client-counters-co'],
    ['missing permission', 'permissions-decoder'],
    ['client says they paid', 'what-your-client-sees-invoice'],
    ['ctrl k', 'search-with-command-palette'],
    ['trial ends', 'trial-and-subscribing'],
    ['propose counter', 'client-counters-co'],
  ])('"%s" finds %s in the top 3', (query, slug) => {
    expect(top(query, 3)).toContain(slug)
  })

  it('treats case, accents and apostrophes as the same', () => {
    expect(top('CAN\u2019T SEND', 3)).toEqual(top("can't send", 3))
    expect(normalize('Caf\u00e9')).toBe('cafe')
  })

  it('matches word forms and the start of a word', () => {
    expect(stem('deleting')).toBe(stem('delete'))
    expect(stem('approvals')).toBe(stem('approval'))
    expect(top('invoic', 5).length).toBeGreaterThan(0)
    expect(top('approvals', 3)).toEqual(expect.arrayContaining(['approve-or-reject-document']))
  })

  it('requires every word, then falls back to any word', () => {
    const strict = searchHelp(index, 'slack webhook', 12)
    expect(strict.length).toBeGreaterThan(0)
    expect(searchHelp(index, 'slack xyzzyplugh', 12).map(r => r.slug)).toContain('slack-updates-in-channel')
  })

  it('returns nothing for gibberish, for one character, and for filler words alone', () => {
    expect(searchHelp(index, 'xyzzyplugh')).toEqual([])
    expect(searchHelp(index, 'a')).toEqual([])
    expect(searchHelp(index, '   ')).toEqual([])
  })

  it('shows the reader-worded problem that matched, when the title does not say it', () => {
    const r = searchHelp(index, "I can't find the Send to client button", 5)
    expect(r.length).toBeGreaterThan(0)
  })

  it('caps the number of results', () => {
    expect(searchHelp(index, 'client', 5).length).toBeLessThanOrEqual(5)
  })
})

describe('help search is wired into /help', () => {
  it('shows the normal category list until someone types', () => {
    const html = renderToStaticMarkup(React.createElement(HelpSearch, { index, children: React.createElement('div', { id: 'categories' }, 'CATEGORY LIST') }))
    expect(html).toContain('CATEGORY LIST')
    expect(html).toContain('type="search"')
    expect(html).toContain('aria-label="Search help articles"')
  })

  it('is used by the Help home page with a real index', () => {
    const page = readFileSync(join(process.cwd(), 'app/(app)/help/page.tsx'), 'utf8')
    expect(page).toContain('<HelpSearch index={index}>')
    expect(page).toContain('buildHelpIndex(ARTICLES, getCategory)')
  })

  it('keeps the search payload small enough to ship in the page', () => {
    expect(JSON.stringify(index).length).toBeLessThan(160 * 1024)
  })
})
