// Renders the real article to HTML: checks the layout produces every section, escapes content, and links stay in-app.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import HelpArticleView from '@/components/help/HelpArticleView'
import { ARTICLES } from '@/lib/help'

describe('HelpArticleView', () => {
  for (const a of ARTICLES) {
    it(`renders ${a.slug} with every section`, () => {
      const html = renderToStaticMarkup(React.createElement(HelpArticleView, { article: a }))
      expect(html).toContain(a.title)
      expect((html.match(/<li class="[^"]*step[^"]*"/g) ?? []).length).toBe(a.steps.length)
      for (const heading of ['The short answer', 'Step by step', 'Do', 'What happens next']) expect(html).toContain(heading)
      expect(html).toContain('support@scopegov.app')
      expect(html).not.toContain('**')
      expect(html).not.toMatch(/href="https?:\/\/(?!support)/)
    })
  }
})
