'use client'
import Link from 'next/link'
import { useState } from 'react'
import styles from '@/styles/marketing.module.css'
import Reveal from './Reveal'
import { CALC_BOUNDS, HOME_PLANS, calcScopeLeak, clampField } from './pricing-data'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const monthly2 = (n: number) => '$' + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '')

export default function PricingSection() {
  // Raw strings so a field can be cleared while typing; every read is clamped.
  const [f, setF] = useState({ projects: '12', value: '5000', creep: '22', rec: '72', seats: '2', active: '4' })
  const [annual, setAnnual] = useState(false)
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
  const r = calcScopeLeak(inputs)

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
          <p className={styles.sub}>All figures in USD. Edit anything.</p>
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
        </form>

        <div className={styles.result} aria-live="polite">
          <div>
            <div className={styles.k}>Scope you give away each year</div>
            <div className={styles.loss}>{usd.format(r.leaked)}</div>
            <p className={styles.lossSub}>Projects &times; value &times; share outside the SOW.</p>
            <div className={styles.rrow}><span>Recoverable at your rate</span><b>{usd.format(r.recoverable)}</b></div>
            <div className={styles.rrow}><span>Plan that fits</span><b>{r.plan ? `${r.plan.name} · $${r.plan.monthly}/mo` : 'Talk to us'}</b></div>
            <div className={styles.rrow}><span>Net after the plan, per year</span><b>{r.net === null ? '—' : `${r.net >= 0 ? '+' : '−'}${usd.format(Math.abs(r.net))}`}</b></div>
            {!r.plan ? (
              <div className={styles.verd}>No standard plan covers more than 10 seats. <a href="mailto:hello@scopegov.app"><strong>Tell us what you need</strong></a> and we&rsquo;ll find a fit.</div>
            ) : r.worthIt ? (
              <div className={`${styles.verd} ${styles.good}`}><strong>Worth it on these numbers.</strong> {r.plan.name} covers its own cost in about {r.paybackWeeks} week{r.paybackWeeks === 1 ? '' : 's'}, then the rest is margin you were giving away.</div>
            ) : (
              <div className={styles.verd}><strong>Not yet.</strong> At these numbers {r.plan.name} wouldn&rsquo;t pay for itself. Try a higher share outside the SOW if that matches your last few projects, or use the <Link href="/calculator">full calculator</Link>.</div>
            )}
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
                <li><span>Seats</span><span>{p.seats}</span></li>
                <li><span>Active projects</span><span>{p.projects === null ? 'Unlimited' : p.projects}</span></li>
                <li><span>Guardian monitoring</span><span className={styles.ck}>&#10003;</span></li>
                <li><span>Full SOW history</span>{p.fullHistory ? <span className={styles.ck}>&#10003;</span> : <span>Last 10</span>}</li>
                <li><span>Custom roles</span>{p.customRoles ? <span className={styles.ck}>&#10003;</span> : <span className={styles.ds}>&mdash;</span>}</li>
              </ul>
              <Link className={`${styles.btn} ${featured ? styles.btnPrimary : styles.btnGhost} ${styles.btnFull}`} href={`/signup?plan=${p.key}`}>Start trial</Link>
            </article>
          )
        })}
      </Reveal>

      <div className={styles.priceNote}>
        <span>Every plan includes unlimited Guardian monitoring and AI-drafted SOWs</span>
        <span>Clients sign without an account</span>
        <span>Cancel anytime: your workspace stays read-only, so you can still view and export everything</span>
        <span>The calculator tells you when a plan doesn&rsquo;t pay off</span>
      </div>
    </div>
  )
}
