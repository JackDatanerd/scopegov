'use client'
import { useEffect, useState } from 'react'
import styles from '@/styles/marketing.module.css'
import Reveal from './Reveal'

// Sample data shown on the marketing page; labelled "illustrative" there. [name, typical ask, share of flags %, change vs previous period in points]
type Row = [string, string, number, number]
const CATS: Record<'week' | 'month', Row[]> = {
  week: [
    ['Extra revision rounds', '“One more round, just small tweaks.”', 29, 2],
    ['Extra pages and screens', '“Can you add one more page?”', 21, -1],
    ['New formats and resizes', '“Can we get this in a story size too?”', 16, 1],
    ['Copy changes after approval', '“We tweaked the wording. Can you swap it in?”', 14, 0],
    ['Third-party integrations', '“It’s just an API key.”', 9, -1],
    ['Extra meetings and calls', '“Can we hop on a quick call with the team?”', 7, 1],
    ['Rush and compressed timelines', '“We need it by Thursday instead.”', 4, -2],
  ],
  month: [
    ['Extra revision rounds', '“One more round, just small tweaks.”', 31, 1],
    ['Extra pages and screens', '“Can you add one more page?”', 19, 1],
    ['New formats and resizes', '“Can we get this in a story size too?”', 15, -1],
    ['Copy changes after approval', '“We tweaked the wording. Can you swap it in?”', 13, 0],
    ['Third-party integrations', '“It’s just an API key.”', 10, -1],
    ['Extra meetings and calls', '“Can we hop on a quick call with the team?”', 8, 1],
    ['Rush and compressed timelines', '“We need it by Thursday instead.”', 4, -1],
  ],
}

export default function ScopeCategories() {
  const [range, setRange] = useState<'week' | 'month'>('week')
  const [grown, setGrown] = useState(false)
  const rows = CATS[range]
  const max = Math.max(...rows.map((r) => r[2]))

  // Grow the bars from 0 on first paint and again whenever the range changes.
  useEffect(() => {
    setGrown(false)
    let r2 = 0
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setGrown(true))
    })
    return () => {
      cancelAnimationFrame(r1)
      cancelAnimationFrame(r2)
    }
  }, [range])

  return (
    <div className={`${styles.wrap} ${styles.catGrid}`}>
      <Reveal>
        <p className={styles.eyebrow}>What clients ask for &ldquo;just quickly&rdquo;</p>
        <h2 id="cat-h">Where scope creeps, <em className={styles.accent}>ranked.</em></h2>
        <p className={`${styles.lede} ${styles.catLede}`}>The same handful of requests drain most of the margin. Know which one is yours before the next kickoff call.</p>
        <div className={styles.seg} role="group" aria-label="Time range">
          <button type="button" aria-pressed={range === 'week'} onClick={() => setRange('week')}>This week</button>
          <button type="button" aria-pressed={range === 'month'} onClick={() => setRange('month')}>This month</button>
        </div>
        <div className={styles.callout}>
          <p><b>Which of these is quietly eating your margin?</b> Put your own project count and values in the calculator and see the number.</p>
          <a className={`${styles.btn} ${styles.btnGhost}`} href="#pricing">Estimate my scope leak &darr;</a>
        </div>
      </Reveal>
      <Reveal>
        <ol className={styles.cats} aria-label="Top scope creep categories by share of flags">
          {rows.map((r, i) => {
            const d = r[3]
            const cls = d > 0 ? styles.up : d < 0 ? styles.down : ''
            const arrow = d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : '–'
            const lab = d > 0 ? `up ${d} points` : d < 0 ? `down ${Math.abs(d)} points` : 'no change'
            const w = `${((r[2] / max) * 100).toFixed(1)}%`
            return (
              <li className={styles.cat} key={r[0]}>
                <span className={styles.rk}>{i + 1}</span>
                <span className={styles.nm}>{r[0]}<span className={styles.ask}>{r[1]}</span></span>
                <span className={styles.pct}>{r[2]}%</span>
                <span className={styles.bar}><i style={{ width: grown ? w : 0, ['--w' as string]: w } as React.CSSProperties} /></span>
                <span className={`${styles.dl} ${cls}`.trim()} aria-label={`${lab} versus previous period`}>{arrow}</span>
              </li>
            )
          })}
        </ol>
        <p className={`${styles.illustrative} ${styles.catsNote}`}>Share of all Guardian flags. Arrows show change versus the previous period.</p>
      </Reveal>
    </div>
  )
}
