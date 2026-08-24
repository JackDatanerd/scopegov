'use client'
import { useState } from 'react'
import styles from '@/styles/marketing.module.css'

type Verdict = 'out' | 'in'
type Sample = { text: string; verdict: Verdict; reason: string }

// Lightweight, deliberately transparent pattern-matcher for the marketing
// demo only — this is NOT the real Guardian classifier (that's an
// Anthropic-backed pipeline in lib/ai/guardian.ts, scoped to a workspace's
// actual signed SOW). This just needs to feel honest and responsive for a
// visitor testing a couple of sample requests against the fictional
// Willow & Finch SOW shown in the hero above.
const SAMPLES: Sample[] = [
  {
    text: "Could we also get a blog layout added while you're in there?",
    verdict: 'out',
    reason: 'Blog layout design is named explicitly under §3 — Out of scope in the signed SOW. Flagged before any work starts.',
  },
  {
    text: 'Small copy tweak on the homepage headline.',
    verdict: 'in',
    reason: 'A text edit to an existing deliverable — covered under the signed homepage design line. No change order needed.',
  },
  {
    text: "One more revision round — promise this is the last one.",
    verdict: 'out',
    reason: 'Requests past the agreed revision count fall outside signed scope, however small — flagged for your review.',
  },
]

const OUT_SIGNALS = ['blog', 'cms', 'new page', 'new section', 'also add', 'also get', 'one more', 'another round', 'extra round', 'logo', 'rebrand', 'redesign the', 'email template', 'landing page']
const IN_SIGNALS = ['copy tweak', 'typo', 'fix the text', 'small tweak', 'wording change', 'headline change']

function firstWords(text: string, n: number) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').slice(0, n).join(' ')
}

function classify(text: string): Sample {
  const t = text.toLowerCase()
  const exact = SAMPLES.find((s) => t.includes(firstWords(s.text, 4)))
  if (exact) return exact
  if (OUT_SIGNALS.some((s) => t.includes(s))) {
    return { text, verdict: 'out', reason: 'This reads like a net-new addition or a request past your agreed limits — Guardian would flag it for a change order before work starts.' }
  }
  if (IN_SIGNALS.some((s) => t.includes(s))) {
    return { text, verdict: 'in', reason: 'This reads like a minor edit within an existing, signed deliverable.' }
  }
  return { text, verdict: 'out', reason: "Guardian couldn't confirm a match to §1 — Deliverables. Anything it can't confirm is in scope gets flagged, not assumed." }
}

export default function GuardianTryIt() {
  const [input, setInput] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<Sample | null>(null)
  const [shown, setShown] = useState(false)

  function run(text: string) {
    const value = text.trim()
    if (!value) return
    setChecking(true)
    setShown(false)
    window.setTimeout(() => {
      setResult(classify(value))
      setChecking(false)
      requestAnimationFrame(() => setShown(true))
    }, 450)
  }

  const badgeVisible = !!result && shown
  const badgeClass = result?.verdict === 'out' ? styles.severityOut : styles.severityIn

  return (
    <div className={styles.caseFile}>
      <div className={styles.caseFileHead}>
        <div className={styles.caseFileHeadLbl}>Try it · scoped to Willow &amp; Finch, §3</div>
        <div className={`${styles.severityBadge} ${badgeClass} ${badgeVisible ? styles.severityBadgeShow : ''}`}>
          {result?.verdict === 'out' ? 'Flagged' : 'In scope'}
        </div>
      </div>
      <div className={styles.caseFileBody}>
        <p className={styles.caseFileIntro}>
          Paste a client message and watch Guardian check it against the signed SOW — the same check that runs on every real project.
        </p>
        <textarea
          className={styles.tryTextarea}
          rows={3}
          placeholder="e.g. “Could we also get a blog layout added while you're in there?”"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className={styles.caseActions}>
          <button
            type="button"
            className={`${styles.caseBtn} ${styles.caseBtnPrimary}`}
            onClick={() => run(input)}
            disabled={checking}
          >
            {checking ? 'Checking…' : 'Check with Guardian'}
          </button>
        </div>
        <div className={styles.caseChips}>
          {SAMPLES.map((s) => (
            <button
              key={s.text}
              type="button"
              className={`${styles.caseBtn} ${styles.caseChip}`}
              onClick={() => { setInput(s.text); run(s.text) }}
            >
              {s.text.length > 34 ? `${s.text.slice(0, 34)}…` : s.text}
            </button>
          ))}
        </div>
        {result && (
          <div className={`${styles.tryVerdict} ${result.verdict === 'out' ? styles.tryVerdictOut : styles.tryVerdictIn} ${shown ? styles.tryVerdictShow : ''}`}>
            <span className={styles.vdot} />
            <div>
              <strong>{result.verdict === 'out' ? 'Flagged — outside signed scope' : 'Covered — inside signed scope'}</strong>
              <span>{result.reason}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
