'use client'

// components/help/HelpSearch.tsx
//
// The search box on the Help home page. While the box is empty (or has under two characters) it shows `children`, the normal
// category list rendered on the server. Once someone types, it replaces that list with ranked results from lib/help/search.ts.
// Everything runs in the browser over a small index passed in by the page, so there is no request per keystroke.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { searchHelp, type HelpSearchEntry } from '@/lib/help/search'
import s from '@/styles/help.module.css'

export default function HelpSearch({ index, children }: { index: HelpSearchEntry[]; children: React.ReactNode }) {
  const [q, setQ] = useState('')
  const trimmed = q.trim()
  const searching = trimmed.length >= 2
  const results = useMemo(() => (searching ? searchHelp(index, trimmed) : []), [index, trimmed, searching])

  return (
    <>
      <div className={s.searchBox}>
        <i className="ti ti-search" aria-hidden="true" />
        <input
          type="search"
          className={s.searchInput}
          placeholder="Search help, e.g. “can’t send”, “invoice paid”, “read-only”"
          aria-label="Search help articles"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') setQ('') }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {searching ? (
        <div role="region" aria-label="Search results" aria-live="polite">
          <p className={s.searchCount}>
            {results.length === 0 ? '' : `${results.length} article${results.length === 1 ? '' : 's'}`}
          </p>
          {results.length === 0 ? (
            <div className={s.searchEmpty}>
              <strong>Nothing matched &ldquo;{trimmed}&rdquo;.</strong> Try fewer or different words, or email{' '}
              <a href="mailto:support@scopegov.app">support@scopegov.app</a> and tell us what you were trying to do.
            </div>
          ) : (
            <div className={s.results}>
              {results.map(r => (
                <Link key={r.slug} href={`/help/${r.slug}`} className={s.card}>
                  <span className={s.resultCat}>{r.categoryTitle}</span>
                  <span className={s.cardTitle}>{r.title}</span>
                  {r.matchedSymptom ? <span className={s.resultSymptom}>Covers: &ldquo;{r.matchedSymptom}&rdquo;</span> : null}
                  <span className={s.cardSummary}>{r.summary}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : children}
    </>
  )
}
