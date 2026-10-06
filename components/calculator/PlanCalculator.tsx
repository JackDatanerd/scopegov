'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import styles from '@/styles/calculator.module.css'
import { formatCurrency, PLAN_LABELS } from '@/lib/utils/format'
import { computeRoi, BLANK_INPUTS, DEFAULT_RECOVERY_RATE, type RoiInputs } from '@/lib/billing/roi-model'
import type { MeasuredNumbers } from '@/lib/billing/roi-inputs'

interface Props {
  /** 'app' = signed-in, prefilled from the workspace; 'public' = blank, signup CTA. */
  mode: 'app' | 'public'
  measured: MeasuredNumbers | null
  defaults: Partial<RoiInputs>
  /** app mode only: whether the viewer can actually change the plan. */
  canManageBilling?: boolean
}

const s = (n: number | undefined) => (n === undefined || n === null ? '' : String(n))
const toNum = (v: string) => (v.trim() === '' ? 0 : Number(v))

export default function PlanCalculator({ mode, measured, defaults, canManageBilling = false }: Props) {
  const start = { ...BLANK_INPUTS, ...defaults }
  const [projectsPerYear, setProjectsPerYear] = useState(s(start.projectsPerYear))
  const [avgProjectValue, setAvgProjectValue] = useState(s(start.avgProjectValue))
  const [creepPct, setCreepPct] = useState(s(start.creepPct))
  const [grantedFree, setGrantedFree] = useState(s(Math.round(start.grantedFreeValue)))
  const [recoveryPct, setRecoveryPct] = useState(s(Math.round(start.recoveryRate * 100)))
  const [seats, setSeats] = useState(s(start.seatsNeeded))
  const [activeProjects, setActiveProjects] = useState(s(start.activeProjectsNeeded))
  const [needsRoles, setNeedsRoles] = useState(start.needsCustomRoles)
  const [needsHistory, setNeedsHistory] = useState(start.needsFullHistory)
  const [interval, setIntervalVal] = useState<'monthly' | 'annual'>(start.interval)
  const [currency, setCurrency] = useState(start.currency)
  const [fx, setFx] = useState('')

  const result = useMemo(() => computeRoi({
    projectsPerYear: toNum(projectsPerYear), avgProjectValue: toNum(avgProjectValue), creepPct: toNum(creepPct),
    grantedFreeValue: toNum(grantedFree), recoveryRate: toNum(recoveryPct) / 100,
    seatsNeeded: toNum(seats), activeProjectsNeeded: toNum(activeProjects),
    needsCustomRoles: needsRoles, needsFullHistory: needsHistory, interval,
    currency, fxToUsd: fx.trim() === '' ? null : Number(fx),
  }), [projectsPerYear, avgProjectValue, creepPct, grantedFree, recoveryPct, seats, activeProjects, needsRoles, needsHistory, interval, currency, fx])

  const cur = result.inputs.currency
  const money = (n: number) => formatCurrency(Math.round(n), cur)
  const rec = result.recommended
  const planName = (p: string) => PLAN_LABELS[p] ?? p
  const isUsd = cur === 'USD'

  return (
    <div className={styles.calc}>
      <div className={styles.hd}>
        <h1 className={styles.title}>What is scope creep costing you?</h1>
        <p className={styles.sub}>
          An estimate, built from your numbers, of the work you give away and what a ScopeGov plan could win back.
          Every figure below is editable and every assumption is listed, so you can check the maths yourself.
        </p>
      </div>

      <div className={styles.grid}>
        <div>
          {mode === 'app' && measured && (
            <div className={`${styles.card} ${styles.measured}`}>
              <h2 className={styles.cardTitle}>From your workspace · last {measured.windowDays} days</h2>
              <ul className={styles.measuredList}>
                <li>Work granted free (exceptions): <b>{formatCurrency(Math.round(measured.grantedFreeValue), measured.currency)}</b></li>
                <li>Already recovered through change orders: <b>{formatCurrency(Math.round(measured.recoveredValue), measured.currency)}</b></li>
                <li>Scope flags raised: <b>{measured.totalFlags}</b>, of which <b>{measured.convertedToCo}</b> became accepted change orders</li>
                <li>Projects started: <b>{measured.projectsStarted}</b> · active now: <b>{measured.activeProjects}</b> · team members: <b>{measured.activeMembers}</b></li>
              </ul>
              {measured.mixedCurrencies && <div className={styles.warn}>Your projects use more than one currency; these figures cover {measured.currency} only.</div>}
              {measured.truncated && <div className={styles.warn}>Your workspace has more records than one summary reads, so these figures may be slightly low.</div>}
              {measured.windowDays < 90 && <div className={styles.warn}>Your workspace is only {measured.windowDays} days old. These figures are what you have actually done so far, not a yearly projection — adjust them to what a normal year looks like.</div>}
            </div>
          )}

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Your work</h2>
            <div className={styles.row2}>
              <div className={styles.field}>
                <label htmlFor="c-ppy">Projects per year</label>
                <input id="c-ppy" className={styles.input} inputMode="numeric" value={projectsPerYear} onChange={e => setProjectsPerYear(e.target.value)} />
              </div>
              <div className={styles.field}>
                <label htmlFor="c-apv">Average project value</label>
                <input id="c-apv" className={styles.input} inputMode="decimal" value={avgProjectValue} onChange={e => setAvgProjectValue(e.target.value)} />
              </div>
            </div>
            <div className={styles.row2}>
              <div className={styles.field}>
                <label htmlFor="c-cur">Currency</label>
                {mode === 'app' && measured
                  ? <input id="c-cur" className={styles.input} value={currency} readOnly />
                  : <input id="c-cur" className={styles.input} value={currency} maxLength={3} onChange={e => setCurrency(e.target.value.toUpperCase())} />}
              </div>
              {!isUsd && (
                <div className={styles.field}>
                  <label htmlFor="c-fx">1 {cur} = how many USD?</label>
                  <input id="c-fx" className={styles.input} inputMode="decimal" placeholder="e.g. 0.0077" value={fx} onChange={e => setFx(e.target.value)} />
                  <span className={styles.hint}>Plans are priced in USD. Enter today&rsquo;s rate to compare.</span>
                </div>
              )}
            </div>
            <div className={styles.field}>
              <label htmlFor="c-creep">Scope creep, as a % of project value</label>
              <input id="c-creep" className={styles.input} inputMode="decimal" value={creepPct} onChange={e => setCreepPct(e.target.value)} />
              <span className={styles.hint}>Your honest estimate of extra work done outside the contract. 10% is a cautious starting guess.</span>
            </div>
            <div className={styles.field}>
              <label htmlFor="c-free">Work you know you gave away free (per year)</label>
              <input id="c-free" className={styles.input} inputMode="decimal" value={grantedFree} onChange={e => setGrantedFree(e.target.value)} />
              <span className={styles.hint}>
                {mode === 'app' && measured ? 'Pre-filled from your exceptions log.' : 'Optional. If you track it, enter it here.'} We use the larger of this and the estimate above, never both added together.
              </span>
            </div>
          </div>

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>What you expect to win back</h2>
            <div className={styles.field}>
              <label htmlFor="c-rec">Share of leaked value you expect to recover (%)</label>
              <input id="c-rec" className={styles.input} inputMode="decimal" value={recoveryPct} onChange={e => setRecoveryPct(e.target.value)} />
              <span className={styles.hint}>
                {Math.round(DEFAULT_RECOVERY_RATE * 100)}% is a placeholder starting point, not a benchmark or a promise. Change it to what feels realistic for your clients.
              </span>
              {measured?.ownRecoveryRate != null && (
                <span className={styles.hint}>
                  In your workspace {measured.convertedToCo} of {measured.totalFlags} flags became accepted change orders ({Math.round(measured.ownRecoveryRate * 100)}%).{' '}
                  <button type="button" className={styles.link} onClick={() => setRecoveryPct(String(Math.round(measured.ownRecoveryRate! * 100)))}>Use that rate</button>
                </span>
              )}
            </div>
          </div>

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>What you need from a plan</h2>
            <div className={styles.row2}>
              <div className={styles.field}>
                <label htmlFor="c-seats">People who need a seat</label>
                <input id="c-seats" className={styles.input} inputMode="numeric" value={seats} onChange={e => setSeats(e.target.value)} />
              </div>
              <div className={styles.field}>
                <label htmlFor="c-act">Projects active at once</label>
                <input id="c-act" className={styles.input} inputMode="numeric" value={activeProjects} onChange={e => setActiveProjects(e.target.value)} />
              </div>
            </div>
            <label className={styles.check}><input type="checkbox" checked={needsRoles} onChange={e => setNeedsRoles(e.target.checked)} /> I need custom roles &amp; permissions</label>
            <label className={styles.check}><input type="checkbox" checked={needsHistory} onChange={e => setNeedsHistory(e.target.checked)} /> I need my full invoice &amp; SOW history and exports</label>
            <div className={styles.field} style={{ marginTop: 8 }}>
              <span className={styles.label}>Billing</span>
              <div className={styles.seg} role="group" aria-label="Billing interval">
                <button type="button" aria-pressed={interval === 'monthly'} onClick={() => setIntervalVal('monthly')}>Monthly</button>
                <button type="button" aria-pressed={interval === 'annual'} onClick={() => setIntervalVal('annual')}>Annual</button>
              </div>
            </div>
          </div>
        </div>

        <div>
          {result.verdict === 'worth_it' && rec && rec.net !== null && (
            <div className={`${styles.verdict} ${styles.verdictGood}`}>
              <p className={styles.verdictTitle}>{planName(rec.plan)} looks like it pays for itself</p>
              <p>
                At these numbers you would recover an estimated {money(result.recoverable)} a year against a plan cost of {money(rec.annualCost!)}
                {rec.paybackMonths !== null && <> — about {rec.paybackMonths < 1 ? 'under a month' : `${Math.ceil(rec.paybackMonths)} month${Math.ceil(rec.paybackMonths) === 1 ? '' : 's'}`} to cover the year&rsquo;s price</>}.
              </p>
            </div>
          )}
          {result.verdict === 'not_yet' && rec && (
            <div className={`${styles.verdict} ${styles.verdictNeutral}`}>
              <p className={styles.verdictTitle}>At these numbers, {planName(rec.plan)} would not pay for itself yet</p>
              <p>
                {planName(rec.plan)} is the smallest plan that fits you, and it costs more than the {money(result.recoverable)} a year you would recover.
                If you think you leak more than this estimate, raise the percentage and see what changes. If not, you may not need a plan yet.
              </p>
            </div>
          )}
          {result.verdict === 'needs_fx' && rec && (
            <div className={`${styles.verdict} ${styles.verdictNeutral}`}>
              <p className={styles.verdictTitle}>{planName(rec.plan)} fits you — add an exchange rate to compare costs</p>
              <p>Plans are priced in USD and your figures are in {cur}. Enter the rate on the left and we will show the net.</p>
            </div>
          )}
          {result.verdict === 'no_plan_fits' && (
            <div className={`${styles.verdict} ${styles.verdictNeutral}`}>
              <p className={styles.verdictTitle}>Your team is bigger than any single plan</p>
              <p>The largest plan covers 10 seats. Reach out and we will work out what fits.</p>
            </div>
          )}

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>How the number is built</h2>
            <ul className={styles.lines}>
              <li>
                <span>Scope creep, your estimate<small>{result.inputs.projectsPerYear} projects × {money(result.inputs.avgProjectValue)} × {result.inputs.creepPct}%</small></span>
                <span className={styles.num}>{money(result.estimatedCreep)}</span>
              </li>
              <li>
                <span>Work granted free<small>{mode === 'app' && measured ? 'measured from your exceptions log' : 'entered by you'}</small></span>
                <span className={styles.num}>{money(result.grantedFree)}</span>
              </li>
              <li>
                <span>Leaked per year<small>the larger of the two — {result.leakedFrom === 'measured' ? 'your granted-free figure' : 'your estimate'}</small></span>
                <span className={styles.num}>{money(result.leaked)}</span>
              </li>
              <li>
                <span>Recoverable per year<small>leaked × {Math.round(result.inputs.recoveryRate * 100)}%</small></span>
                <span className={`${styles.num} ${styles.pos}`}>{money(result.recoverable)}</span>
              </li>
              {rec && (
                <li>
                  <span>{planName(rec.plan)} plan, per year<small>{interval === 'annual' ? 'annual billing' : 'monthly billing × 12'}{!isUsd && ' · converted at your rate'}</small></span>
                  <span className={styles.num}>{rec.annualCost !== null ? money(rec.annualCost) : formatCurrency(rec.annualCostUsd, 'USD')}</span>
                </li>
              )}
              {rec && rec.net !== null && (
                <li>
                  <span><strong>Estimated net per year</strong></span>
                  <span className={`${styles.num} ${rec.net >= 0 ? styles.pos : styles.neg}`}>{rec.net >= 0 ? '' : '−'}{money(Math.abs(rec.net))}</span>
                </li>
              )}
            </ul>
          </div>

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Plans compared</h2>
            <table className={styles.table}>
              <thead><tr><th>Plan</th><th>Per year (USD)</th><th>Fits you</th><th>Est. net</th></tr></thead>
              <tbody>
                {result.plans.map(p => (
                  <tr key={p.plan} className={rec?.plan === p.plan ? styles.rec : undefined}>
                    <td>{planName(p.plan)}{rec?.plan === p.plan && <span className={styles.tag}>Recommended</span>}</td>
                    <td className={styles.num}>{formatCurrency(p.annualCostUsd, 'USD')}</td>
                    <td>{p.fits ? 'Yes' : <span className={styles.muted}>No — {p.reasons.join('; ')}</span>}</td>
                    <td className={`${styles.num} ${p.net !== null && p.net < 0 ? styles.neg : ''}`}>{p.net === null ? '—' : `${p.net < 0 ? '−' : ''}${money(Math.abs(p.net))}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className={styles.fine}>Recommended = the cheapest plan that fits your seats, active projects and features. Fit comes before price.</p>
            {rec && (
              mode === 'public'
                ? <Link href={`/signup?plan=${rec.plan}`} className={styles.cta}>Start a free trial</Link>
                : canManageBilling
                  ? <Link href="/settings?tab=billing" className={styles.cta}>Choose a plan</Link>
                  : <p className={styles.fine}>Ask a workspace admin with billing access to choose a plan.</p>
            )}
          </div>

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Assumptions</h2>
            <ul className={styles.assump}>
              <li>This is an estimate based on the numbers you entered. It is not a forecast or a guarantee of any result.</li>
              <li>Granted-free work is treated as part of scope creep, so the two are never added together.</li>
              <li>The recovery rate is yours to set; {Math.round(DEFAULT_RECOVERY_RATE * 100)}% is only a starting point.</li>
              <li>Prices are ScopeGov list prices in USD; taxes and payment fees are not included.</li>
              {mode === 'app' && <li>Measured figures cover the last 12 months, or since your workspace started if that is shorter; nothing is extrapolated.</li>}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
