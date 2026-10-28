'use client'
import Link from 'next/link'
import { useState } from 'react'
import styles from '@/styles/marketing.module.css'
import Reveal from './Reveal'
import { CALC_BOUNDS, HOME_CALC_DEFAULTS, HOME_PLANS, calcScopeLeak, clampField } from './pricing-data'
import { calculatorHref } from '@/lib/billing/roi-url'
import { needInputs, type NeedFlags } from '@/lib/billing/roi-model'
import { FEATURE_NEEDS } from '@/lib/billing/entitlements'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const monthly2 = (n: number) => '$' + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '')

export default function PricingSection() {
  // Raw strings so a field can be cleared while typing; every read is clamped.
  // Starts from the full calculator's own defaults (HOME_CALC_DEFAULTS) so both open on the same numbers.
  const d = HOME_CALC_DEFAULTS
  const [f, setF] = useState({ projects: String(d.projectsPerYear), value: String(d.avgProjectValue), creep: String(d.creepPct), rec: String(d.recoverPct), seats: String(d.seats), active: String(d.activeProjects) })
  const [annual, setAnnual] = useState<boolean>(d.annual)
  const [needs, setNeeds] = useState<NeedFlags>({ customRoles: false, approvalChains: false, integrations: false, portfolio: false, auditExport: false })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }))

  const b = CALC_BOUNDS
  const inputs = {
    projectsPerYear: clampField(f.projects, b.projectsPerYear.min, b.projectsPerYear.max),
    avgProjectValue: clampField(f.value, b.avgProjectValue.min, b.avgProjectValue.max),
    creepPct: clampField(f.creep, b.creepPct.min, b.creepPct.max),
    recoverPct: clampField(f.rec, b.recoverPct.min, b.recoverPct.max),
    seats: clampField(f.seats, b.seats.min, b.seats.max),
    activeProjects: clampField(f.active, b.activeProjects.min, b.activeProjects.max),
  }
  const interval = annual ? 'annual' as const : 'monthly' as const
  const r = calcScopeLeak({ ...inputs, interval, needs })
  // The same numbers, opened in the full calculator (it reads them from the URL).
  const fullCalcHref = calculatorHref({ ...inputs, interval, ...needInputs(needs) })

  return (
    <div className={styles.wrap}>
      <Reveal className={styles.secHead}>
        <p className={styles.eyebrow}>Pricing</p>
        <h2 id="pr-h">Do the math before you look at <em className={styles.accent}>the price.</em></h2>
        <p className={styles.lede}>Your scope leak is the real price. ScopeGov is the cheaper line item. Put in your numbers and we&rsquo;ll tell you honestly whether a plan pays for itself.</p>
      </Reveal>

      <Reveal className={styles.priceTop}>
        <form className={`${styles.panel} ${styles.calc}`} onSubmit={(e) => e.preventDefault()} aria-label="Scope leak calculator">
          <h3>Your numbers</h3>
          <p className={styles.sub}>All figures in USD. Edit anything. Same model as the full calculator.</p>
          <div className={styles.two}>
            <div className={styles.fld}><label htmlFor="cYear">Projects per year</label><input id="cYear" type="number" min={b.projectsPerYear.min} max={b.projectsPerYear.max} value={f.projects} onChange={set('projects')} inputMode="numeric" /></div>
            <div className={styles.fld}><label htmlFor="cVal">Average project value ($)</label><input id="cVal" type="number" min={b.avgProjectValue.min} max={b.avgProjectValue.max} value={f.value} onChange={set('value')} inputMode="numeric" /></div>
          </div>
          <div className={styles.fld}><label htmlFor="cCreep">Work outside the SOW <output>{inputs.creepPct}%</output></label><input id="cCreep" type="range" min={b.creepPct.min} max={b.creepPct.max} value={f.creep} onChange={set('creep')} /></div>
          <div className={styles.fld}><label htmlFor="cRec">Share you&rsquo;d recover <output>{inputs.recoverPct}%</output></label><input id="cRec" type="range" min={b.recoverPct.min} max={b.recoverPct.max} value={f.rec} onChange={set('rec')} /></div>
          <div className={styles.two}>
            <div className={styles.fld}><label htmlFor="cSeats">Seats needed</label><input id="cSeats" type="number" min={b.seats.min} max={b.seats.max} value={f.seats} onChange={set('seats')} inputMode="numeric" /></div>
            <div className={styles.fld}><label htmlFor="cAct">Active projects at once</label><input id="cAct" type="number" min={b.activeProjects.min} max={b.activeProjects.max} value={f.active} onChange={set('active')} inputMode="numeric" /></div>
          </div>
          {FEATURE_NEEDS.map((n, idx) => (
            <label key={n.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: idx === 0 ? 4 : 6 }}>
              <input type="checkbox" checked={needs[n.key]} onChange={(e) => setNeeds((p) => ({ ...p, [n.key]: e.target.checked }))} /> I need {n.label.charAt(0).toLowerCase() + n.label.slice(1)}
            </label>
          ))}
        </form>

        <div className={styles.result} aria-live="polite">
          <div>
            <div className={styles.k}>Scope you give away each year</div>
            <div className={styles.loss}>{usd.format(r.leaked)}</div>
            <p className={styles.lossSub}>Projects &times; value &times; share outside the SOW.</p>
            <div className={styles.rrow}><span>Recoverable at your rate</span><b>{usd.format(r.recoverable)}</b></div>
            <div className={styles.rrow}><span>Plan that fits</span><b>{r.plan ? `${r.plan.name} · ${monthly2(annual ? r.plan.annual / 12 : r.plan.monthly)}/mo${annual ? ' billed yearly' : ''}` : 'Talk to us'}</b></div>
            <div className={styles.rrow}><span>Net after the plan, per year</span><b>{r.net === null ? '—' : `${r.net >= 0 ? '+' : '−'}${usd.format(Math.abs(r.net))}`}</b></div>
            {!r.plan ? (
              <div className={styles.verd}>No standard plan covers more than 10 seats. <a href="mailto:hello@scopegov.app"><strong>Tell us what you need</strong></a> and we&rsquo;ll find a fit.</div>
            ) : r.worthIt ? (
              <div className={`${styles.verd} ${styles.good}`}><strong>Worth it on these numbers.</strong> {r.plan.name} covers its own cost in about {r.paybackWeeks} week{r.paybackWeeks === 1 ? '' : 's'}, then the rest is margin you were giving away.</div>
            ) : (
              <div className={styles.verd}><strong>Not yet.</strong> At these numbers {r.plan.name} wouldn&rsquo;t pay for itself. Try a higher share outside the SOW if that matches your last few projects.</div>
            )}
            <p style={{ fontSize: 12, marginTop: 10, opacity: .8 }}><Link href={fullCalcHref}>Open the full calculator with these numbers &rarr;</Link></p>
          </div>
          <Link className={`${styles.btn} ${styles.btnLight} ${styles.btnFull} ${styles.go}`} href={r.plan ? `/signup?plan=${r.plan.key}` : '/signup'}>Start free trial</Link>
        </div>
      </Reveal>

      <div className={`${styles.seg} ${styles.segBilling}`} role="group" aria-label="Billing period">
        <button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)}>Monthly</button>
        <button type="button" aria-pressed={annual} onClick={() => setAnnual(true)}>Annual: 2 months free</button>
      </div>
      <Reveal className={styles.plans}>
        {HOME_PLANS.map((p) => {
          const fit = r.plan?.key === p.key
          const dim = !!r.plan && !fit
          const featured = p.key === 'pro'
          return (
            <article key={p.key} className={`${styles.plan} ${fit ? styles.fit : ''} ${dim ? styles.dim : ''}`.trim()}>
              <span className={styles.fitTag}>Fits your numbers</span>
              <div className={styles.pn}>{p.name}</div>
              <div className={styles.pp}>{monthly2(annual ? p.annual / 12 : p.monthly)}<small>/mo</small></div>
              <div className={styles.pbill}>{annual ? `Billed ${usd.format(p.annual)} a year` : 'Billed monthly'}</div>
              <p className={styles.pays}>{p.pays}</p>
              <ul>
                {p.rows.map((row) => (
                  <li key={row.label}><span>{row.label}</span>{row.included && row.value === 'Included' ? <span className={styles.ck}>&#10003;</span> : row.included ? <span>{row.value}</span> : <span className={styles.ds}>&mdash;</span>}</li>
                ))}
              </ul>
              <Link className={`${styles.btn} ${featured ? styles.btnPrimary : styles.btnGhost} ${styles.btnFull}`} href={`/signup?plan=${p.key}`}>Start trial</Link>
            </article>
          )
        })}
      </Reveal>

      <div className={styles.priceNote}>
        <span>Every plan includes Guardian monitoring, AI drafting (with a monthly allowance), full invoice and SOW history and CSV export</span>
        <span>Clients sign without an account</span>
        <span>Cancel anytime: your workspace stays read-only, so you can still view and export everything</span>
        <span>The calculator tells you when a plan doesn&rsquo;t pay off</span>
      </div>
    </div>
  )
}
