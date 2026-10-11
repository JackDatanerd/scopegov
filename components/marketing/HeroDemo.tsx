'use client'
import { useEffect, useRef, useState } from 'react'
import styles from '@/styles/marketing.module.css'

/**
 * The hero's animated example: a client email arrives, Guardian checks it against the signed SOW, flags it, a change
 * order is drafted, the client approves. Purely illustrative (fictional client and numbers). Steps 1..5 reveal in
 * sequence; "Replay" restarts. With reduced motion, or no JS, all five steps are shown at once.
 */
const STEP_TIMES = [350, 1500, 3000, 4700, 6400]

export default function HeroDemo() {
  const [step, setStep] = useState(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  function clear() {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }

  function play() {
    clear()
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      setStep(5)
      return
    }
    setStep(0)
    STEP_TIMES.forEach((ms, i) => {
      timers.current.push(setTimeout(() => setStep(i + 1), ms))
    })
  }

  useEffect(() => {
    play()
    return clear
  }, [])

  const on = (n: number) => `${styles.cfStep} ${step >= n ? styles.on : ''}`

  return (
    <div className={styles.casefile} role="group" aria-label="Animated example of Guardian catching an out-of-scope request">
      <div className={styles.cfBar}>
        <span>Brand Refresh · Fernhill Co.</span>
        <span className={styles.live}><i />Guardian active</span>
      </div>
      <div className={styles.cfBody}>
        <div className={on(1)}>
          <div className={styles.mail}>
            <div className={styles.mailH}><span><b>Jordan Reyes</b> · Fernhill Co.</span><span>Tue 4:52 pm</span></div>
            <p>&ldquo;Love the direction! Could you also pull together a short investor deck for Thursday? Shouldn&rsquo;t take long.&rdquo;</p>
          </div>
        </div>
        <div className={on(2)}>
          <div className={styles.scan}><span>Checking against signed SOW v2</span><span className={styles.bar} /></div>
        </div>
        <div className={on(3)}>
          <div className={styles.verdict}>
            <span className={`${styles.stamp} ${styles.red}`}>Out of scope</span>
            <div className={styles.k}>Guardian · 94% confidence</div>
            <p>Presentations are excluded from this project.</p>
            <div className={styles.cite}>SOW §3.2 — &ldquo;&hellip;presentations and decks&hellip; are not included.&rdquo;</div>
          </div>
        </div>
        <div className={on(4)}>
          <div className={styles.co}>
            <div>
              <div className={styles.k}>Change order drafted · CO-014</div>
              <h4>Investor deck, up to 12 slides</h4>
              <div className={styles.sub}>One click to review and send</div>
            </div>
            <div className={styles.amt}>$1,800</div>
          </div>
        </div>
        <div className={on(5)}>
          <div className={styles.approved}>
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
              <circle cx="13" cy="13" r="12" stroke="#B7DCC8" strokeWidth="2" />
              <path d="m7.5 13.5 3.8 3.8 7.2-7.6" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div><b>Approved by Jordan, six hours later</b><span>Signed in the client portal. Invoice queued.</span></div>
          </div>
        </div>
      </div>
      <button type="button" className={styles.replay} onClick={play} aria-label="Replay the animated example">&#8635; Replay</button>
    </div>
  )
}
