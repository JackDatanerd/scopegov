'use client'
import { useEffect, useState } from 'react'
import styles from '@/styles/marketing.module.css'

/**
 * The looping hero illustration: a signed SOW, a client message arriving,
 * Guardian flagging the out-of-scope clause, then a change order going out.
 * Purely illustrative (client/agency names here are a fictional example
 * used consistently across the hero and the live Guardian demo below it).
 */
export default function HeroDocMock() {
  const [step, setStep] = useState(0) // 0=idle, 1=message, 2=flagged, 3=co sent

  useEffect(() => {
    let cancelled = false
    function run() {
      setStep(0)
      const t1 = setTimeout(() => !cancelled && setStep(1), 400)
      const t2 = setTimeout(() => !cancelled && setStep(2), 1900)
      const t3 = setTimeout(() => !cancelled && setStep(3), 3400)
      return [t1, t2, t3]
    }
    let timers = run()
    const interval = setInterval(() => {
      timers.forEach(clearTimeout)
      timers = run()
    }, 7200)
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
      clearInterval(interval)
    }
  }, [])

  return (
    <div className={styles.docStage}>
      <div className={styles.docMock}>
        <div className={styles.docHead}>
          <div>
            <div className={styles.docHeadLabel}>Statement of Work · v2</div>
            <div className={styles.docHeadTitle}>Willow &amp; Finch — Brand Refresh</div>
          </div>
          <div className={styles.docStatus}>Active</div>
        </div>
        <div className={styles.docBody}>
          <div className={styles.docSectionLbl}>Deliverables</div>
          <div>Logo suite, brand guidelines, 3 templated social assets, primary website homepage design.</div>

          <div className={styles.docSectionLbl}>Out of scope</div>
          <div className={`${styles.clause} ${step >= 2 ? styles.clauseFlagged : ''}`}>
            Blog layout design, ongoing content production, email template systems.
            <span className={`${styles.flagTag} ${step >= 2 ? styles.flagTagShow : ''}`}>⚠ FLAGGED</span>
          </div>

          <div className={styles.docSectionLbl}>Payment terms</div>
          <div>50% due at kickoff, 50% due on final delivery.</div>
        </div>

        <div className={styles.docGuardianPulse}>
          <span className={styles.pulseDot} />
          Guardian monitoring
        </div>
      </div>

      <div className={`${styles.docMsg} ${step >= 1 ? styles.docMsgShow : ''}`}>
        <div className={styles.docMsgFrom}>
          <div className={styles.docMsgAvatar} />
          <div className={styles.docMsgName}>Priya, Willow &amp; Finch</div>
        </div>
        <div className={styles.docMsgText}>&ldquo;could we also get a quick blog layout added while you&rsquo;re in there? 🙏&rdquo;</div>
      </div>

      <div className={`${styles.coChip} ${step >= 3 ? styles.coChipShow : ''}`}>
        <div className={styles.coChipLbl}>Change order — sent</div>
        <div className={styles.coChipTitle}>Blog layout design</div>
        <div className={styles.coChipAmt}>+$2,400</div>
      </div>
    </div>
  )
}
