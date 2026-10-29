// components/help/HelpArticleView.tsx
//
// The one layout every help article uses. Authors supply content (lib/help/types.ts); this component decides how it looks,
// so articles stay consistent without anyone styling anything. A server component: no state, no client JS.

import Link from 'next/link'
import { PLAN_ENTITLEMENTS } from '@/lib/billing/entitlements'
import { helpPermissionLabel } from '@/lib/help/permission-labels'
import { getCategory, relatedArticles } from '@/lib/help'
import type { HelpArticle } from '@/lib/help/types'
import { Inline } from './inline'
import s from '@/styles/help.module.css'

function planLine(plan: HelpArticle['audience']['plan']): string {
  return plan === 'all' ? 'All plans' : `${PLAN_ENTITLEMENTS[plan].name} plan and above`
}

function formatUpdated(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export default function HelpArticleView({ article }: { article: HelpArticle }) {
  const category = getCategory(article.category)
  const related = relatedArticles(article)
  const needs = article.audience.permissions

  return (
    <div className="page">
      <article className={s.article}>
        <nav className={s.crumbs} aria-label="Breadcrumb">
          <Link href="/help">Help</Link>
          {category && <><span aria-hidden="true">/</span><span>{category.title}</span></>}
        </nav>

        <h1 className="page-title">{article.title}</h1>
        <p className={s.summary}>{article.summary}</p>

        <dl className={s.audience}>
          <div><dt>Permission needed</dt><dd>{needs.length ? needs.map(helpPermissionLabel).join(', ') : 'Any member'}</dd></div>
          <div><dt>Plan</dt><dd>{planLine(article.audience.plan)}</dd></div>
          <div><dt>Last checked</dt><dd>{formatUpdated(article.updated)}</dd></div>
        </dl>

        <section className={s.answer} aria-label="The short answer">
          <div className={s.eyebrow}>The short answer</div>
          <p><Inline text={article.shortAnswer} /></p>
        </section>

        {article.beforeYouStart && article.beforeYouStart.length > 0 && (
          <section className={s.block}>
            <h2 className={s.h2}>Before you start</h2>
            <ul className={s.list}>
              {article.beforeYouStart.map((t, i) => <li key={i}><Inline text={t} /></li>)}
            </ul>
          </section>
        )}

        <section className={s.block}>
          <h2 className={s.h2}>Step by step</h2>
          <ol className={s.steps}>
            {article.steps.map((step, i) => (
              <li key={i} className={s.step}>
                <span className={s.stepNum} aria-hidden="true">{i + 1}</span>
                <div className={s.stepBody}>
                  <h3 className={s.h3}>
                    {step.title}
                    {step.minutes ? <span className={s.minutes}>~{step.minutes} min</span> : null}
                  </h3>
                  <p><Inline text={step.body} /></p>
                  {step.details && step.details.length > 0 && (
                    <ul className={s.list}>{step.details.map((d, j) => <li key={j}><Inline text={d} /></li>)}</ul>
                  )}
                  {step.watchFor && (
                    <p className={s.watch}><strong>Watch for:</strong> <Inline text={step.watchFor} /></p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className={s.block}>
          <div className={s.dd}>
            <div className={`${s.dd_col} ${s.do}`}>
              <h2 className={s.h2}>Do</h2>
              <ul className={s.list}>{article.dos.map((t, i) => <li key={i}><Inline text={t} /></li>)}</ul>
            </div>
            <div className={`${s.dd_col} ${s.dont}`}>
              <h2 className={s.h2}>Don&rsquo;t</h2>
              <ul className={s.list}>{article.donts.map((t, i) => <li key={i}><Inline text={t} /></li>)}</ul>
            </div>
          </div>
        </section>

        {article.problems.length > 0 && (
          <section className={s.block}>
            <h2 className={s.h2}>If something looks wrong</h2>
            <div className={s.problems}>
              {article.problems.map((p, i) => (
                <div key={i} className={s.problem}>
                  <div className={s.symptom}><Inline text={p.symptom} /></div>
                  <p><span className={s.tag}>Why</span><span><Inline text={p.meaning} /></span></p>
                  <p><span className={s.tag}>Fix</span><span><Inline text={p.fix} /></span></p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className={s.block}>
          <h2 className={s.h2}>What happens next</h2>
          <ul className={s.list}>{article.whatHappensNext.map((t, i) => <li key={i}><Inline text={t} /></li>)}</ul>
        </section>

        {related.length > 0 && (
          <section className={s.block}>
            <h2 className={s.h2}>Related articles</h2>
            <ul className={s.list}>
              {related.map(r => <li key={r.slug}><Link href={`/help/${r.slug}`}>{r.title}</Link></li>)}
            </ul>
          </section>
        )}

        <p className={s.footer}>
          Still stuck? Email <a href="mailto:support@scopegov.app">support@scopegov.app</a> and tell us what you were trying to do.
        </p>
      </article>
    </div>
  )
}
