// app/(app)/help/page.tsx
//
// Help home: every published article, grouped by category. Content lives in lib/help (see lib/help/AUTHORING.md).
import Link from 'next/link'
import { groupedArticles } from '@/lib/help'
import s from '@/styles/help.module.css'

export const metadata = { title: 'Help' }

export default function HelpHomePage() {
  const groups = groupedArticles()
  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-title">Help</h1>
          <p className="page-sub">Short, practical guides for getting things done in ScopeGov.</p>
        </div>
      </div>

      {groups.map(({ category, articles }) => (
        <section key={category.id} className={s.group}>
          <div className="sec-hd"><div className="sec-title">{category.title}</div></div>
          <p className={s.groupDesc}>{category.description}</p>
          <div className={s.cards}>
            {articles.map(a => (
              <Link key={a.slug} href={`/help/${a.slug}`} className={s.card}>
                <span className={s.cardTitle}>{a.title}</span>
                <span className={s.cardSummary}>{a.summary}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}

      <p className={s.footer}>
        Can&rsquo;t find what you need? Email <a href="mailto:support@scopegov.app">support@scopegov.app</a>.
      </p>
    </div>
  )
}
