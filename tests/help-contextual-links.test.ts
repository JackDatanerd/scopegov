// Guards the contextual help links (the small "?" beside screens and settings): every link must point at a published article,
// be labelled for screen readers, open in a new tab, and never appear on a public page, where /help would bounce to the login screen.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import HelpLink from '@/components/help/HelpLink'
import { getArticle } from '@/lib/help'

const root = process.cwd()

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

const files = [...walk(join(root, 'app')), ...walk(join(root, 'components'))]
const rel = (f: string) => relative(root, f).split(sep).join('/')

interface Use { file: string; tag: string; slug: string }
const uses: Use[] = []
for (const f of files) {
  if (rel(f) === 'components/help/HelpLink.tsx') continue
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/<HelpLink\b[^>]*?\/>/g)) {
    const slug = /slug="([^"]+)"/.exec(m[0])?.[1] ?? ''
    uses.push({ file: rel(f), tag: m[0], slug })
  }
}

describe('contextual help links', () => {
  it('are actually wired into the app', () => {
    expect(uses.length).toBeGreaterThanOrEqual(20)
  })

  it('only point at published articles', () => {
    for (const u of uses) {
      expect(u.slug, `${u.file}: HelpLink has no literal slug`).not.toBe('')
      expect(getArticle(u.slug), `${u.file}: slug "${u.slug}" is not a published help article`).not.toBeNull()
    }
  })

  it('each have a tooltip or visible label (screen readers need one)', () => {
    for (const u of uses) {
      expect(/\b(title|label)=("|\{)/.test(u.tag), `${u.file}: ${u.tag} has no title or label`).toBe(true)
    }
  })

  it('never appear on a public page', () => {
    // Everything under app/ except the signed-in app group and the API is public (portal, calculator, auth, marketing).
    const publicUses = uses.filter(u => u.file.startsWith('app/') && !u.file.startsWith('app/(app)/') && !u.file.startsWith('app/api/'))
    expect(publicUses.map(u => u.file)).toEqual([])
    for (const f of files) {
      const r = rel(f)
      if (r.startsWith('components/portal') || r.startsWith('components/marketing')) {
        expect(readFileSync(f, 'utf8'), r).not.toContain('HelpLink')
      }
    }
  })

  it('is shown on the shared calculator only in the signed-in version', () => {
    const src = readFileSync(join(root, 'components/calculator/PlanCalculator.tsx'), 'utf8')
    expect(src).toMatch(/mode === 'app' && <HelpLink/)
  })

  it('covers the screens and settings people ask about', () => {
    const where = (slug: string) => uses.filter(u => u.slug === slug).map(u => u.file)
    expect(where('why-cant-i-send-sow')).toContain('components/projects/ProjectDetail.tsx')
    expect(where('read-only-workspace')).toContain('components/layout/LapsedBanner.tsx')
    expect(where('guardian-settings')).toContain('components/settings/SettingsClient.tsx')
    expect(where('permissions-decoder')).toContain('components/team/TeamClient.tsx')
    expect(where('read-your-dashboard')).toContain('app/(app)/dashboard/page.tsx')
    expect(where('slack-updates-in-channel')).toContain('components/settings/IntegrationsSection.tsx')
  })
})

describe('HelpLink', () => {
  it('opens the article in a new tab, safely, with an accessible name', () => {
    const html = renderToStaticMarkup(React.createElement(HelpLink, { slug: 'first-project', title: 'Help: your first project' }))
    expect(html).toContain('href="/help/first-project"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('aria-label="Help: your first project (opens in a new tab)"')
    expect(html).toContain('title="Help: your first project"')
  })

  it('shows a visible label when given one', () => {
    const html = renderToStaticMarkup(React.createElement(HelpLink, { slug: 'read-only-workspace', label: 'What does read-only mean?' }))
    expect(html).toContain('What does read-only mean?')
    expect(html).toContain('aria-label="What does read-only mean? (opens in a new tab)"')
  })
})
