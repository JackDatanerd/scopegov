'use client'
import { useEffect, useState } from 'react'
import styles from '@/styles/marketing.module.css'

// Interactive sample for the marketing page only. Not the real Guardian classifier (lib/ai/guardian.ts reads a
// workspace's own signed SOW) — fixed examples against a made-up SOW, labelled as such on the page.
type Tone = 'red' | 'green' | 'gold'

const SOW = [
  { id: '1.1', t: 'Deliverables', x: 'Logo suite (primary, secondary, icon), color palette, typography system, and a 24-page brand guidelines PDF.' },
  { id: '1.2', t: 'File formats', x: 'Final artwork is delivered as SVG, PNG and PDF.' },
  { id: '2.1', t: 'Revisions', x: 'Two (2) rounds of consolidated revisions are included. Further rounds are billed as change orders.' },
  { id: '3.2', t: 'Exclusions', x: 'Social media templates, presentations and decks, packaging, photography and website design are not included.' },
]

const MSGS: { m: string; s: Tone; stamp: string; c: number; clause: string; head: string; why: string; co: { k: string; n: string; a: string; quiet?: boolean } }[] = [
  { m: 'Can we see one more round on the logo? Just small tweaks.', s: 'red', stamp: 'Out of scope', c: 96, clause: '2.1', head: 'A third revision round', why: 'Two rounds are included and both have been used. A further round is billed as a change order.', co: { k: 'Change order drafted', n: 'Additional revision round', a: '$600' } },
  { m: 'Please send the logo as SVG and PNG for the website.', s: 'green', stamp: 'In scope', c: 98, clause: '1.2', head: 'Already covered', why: 'Both formats are listed in the signed deliverables. Guardian stays quiet and nothing gets flagged.', co: { k: 'No action needed', n: 'Send the files', a: '$0', quiet: true } },
  { m: 'Could you also design a few Instagram templates for launch week?', s: 'red', stamp: 'Out of scope', c: 93, clause: '3.2', head: 'Social media templates', why: 'Explicitly excluded in the signed SOW. Drafted as a change order for you to review.', co: { k: 'Change order drafted', n: 'Social media templates (set of 5)', a: '$1,200' } },
  { m: 'The green feels a bit off. Could we try a slightly different shade?', s: 'gold', stamp: 'Borderline', c: 61, clause: '2.1', head: 'Reads like a revision', why: 'This likely counts toward revision round 2 of 2, if that round is still open. Guardian marks it borderline and leaves the call to you.', co: { k: 'Your call', n: 'Count it as a revision, or discuss', a: 'Review', quiet: true } },
]

const HIT: Record<Tone, string> = { red: styles.hitRed, green: styles.hitGreen, gold: styles.hitGold }

export default function GuardianDemo() {
  const [sel, setSel] = useState(0)
  const [meter, setMeter] = useState(0)
  const m = MSGS[sel]

  // Animate the confidence meter from 0 each time a different message is picked.
  useEffect(() => {
    setMeter(0)
    let r2 = 0
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setMeter(m.c))
    })
    return () => {
      cancelAnimationFrame(r1)
      cancelAnimationFrame(r2)
    }
  }, [sel, m.c])

  return (
    <>
      <div className={styles.gStack}>
        <div className={styles.panel}>
          <div className={styles.panelH}><span>Signed SOW · sample</span><span>v2</span></div>
          <div className={styles.sow}>
            {SOW.map((c) => (
              <div key={c.id} className={`${styles.clause} ${c.id === m.clause ? HIT[m.s] : ''}`.trim()}>
                <div className={styles.cid}>§{c.id} · {c.t}</div>
                <p>{c.x}</p>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.panel}>
          <div className={styles.msgs}>
            <p className={styles.msgsLabel}>A client email arrives. Choose one:</p>
            <div className={styles.chips}>
              {MSGS.map((x, i) => (
                <button key={x.m} type="button" className={styles.chip} aria-pressed={i === sel} onClick={() => setSel(i)}>
                  &ldquo;{x.m}&rdquo;
                </button>
              ))}
            </div>
          </div>
          <p className={`${styles.gNote}`}>Interactive sample using a made-up SOW. The real Guardian reads your own signed document.</p>
        </div>
      </div>

      <div className={styles.panel} aria-live="polite">
        <div className={styles.panelH}><span>Guardian&rsquo;s read</span><span>{m.c}% confidence</span></div>
        <div className={styles.gResult}>
          <div className={`${styles.gVerdict} ${styles[m.s]}`}>
            <span className={`${styles.stamp} ${styles[m.s]}`}>{m.stamp}</span>
            <div className={styles.meter}>
              <span>Confidence</span>
              <span className={styles.mTrack}>
                <span className={styles.mFill} style={{ width: `${meter}%`, ['--w' as string]: `${m.c}%` } as React.CSSProperties} />
              </span>
              <b>{m.c}%</b>
            </div>
            <h4>{m.head}</h4>
            <p>{m.why}</p>
            <div className={styles.gCite}>Cited: SOW §{m.clause}</div>
          </div>
          <div className={`${styles.gCo} ${m.co.quiet ? styles.quiet : ''}`.trim()}>
            <div><div className={styles.k}>{m.co.k}</div><b>{m.co.n}</b></div>
            <div className={styles.amt}>{m.co.a}</div>
          </div>
        </div>
      </div>
    </>
  )
}
