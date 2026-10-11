import Link from 'next/link'
// Self-hosted fonts (same policy as app/layout.tsx: no third-party font CDN, so a page view never sends the visitor's
// IP to Google). Imported here rather than in the root layout so only the homepage pays for them.
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import '@fontsource/instrument-sans/400.css'
import '@fontsource/instrument-sans/500.css'
import '@fontsource/instrument-sans/600.css'
import '@fontsource/instrument-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import styles from '@/styles/marketing.module.css'
import MarketingHeader from './MarketingHeader'
import MarketingFooter from './MarketingFooter'
import Reveal from './Reveal'
import CountUp from './CountUp'
import HeroDemo from './HeroDemo'
import GuardianDemo from './GuardianDemo'
import ScopeCategories from './ScopeCategories'
import PricingSection from './PricingSection'
import MobileCta from './MobileCta'

// The headline's underlined phrase, split so each word's underline can draw in on its own (see .rlWord in marketing.module.css).
const REDLINE_WORDS = ['Most', 'agencies', 'never', 'send', 'one.']

const w = (pct: string) => ({ ['--w' as string]: pct } as React.CSSProperties)

const LIFECYCLE = [
  { status: 'Drafted', tone: 'neutral', title: 'Brief in, SOW out', desc: 'Paste a raw brief or client email. ScopeGov drafts a full Statement of Work with deliverables, exclusions and payment terms, ready for you to edit.' },
  { status: 'Signed', tone: 'green', title: 'Client signs, scope locks', desc: 'Your client reviews and signs in a branded portal, no account needed. The moment they sign, Guardian activates on the project.' },
  { status: 'Monitored', tone: 'gold', title: 'Every email, checked', desc: 'Forward client threads to your project’s Guardian address. Anything outside the signed scope is flagged the moment it arrives.' },
  { status: 'Recovered', tone: 'green', title: 'Flag becomes revenue', desc: 'One click turns a flag into a change order, sent for signature. Accepted work updates the contract value automatically.' },
] as const

const FEATURES = [
  { title: 'Guardian AI', desc: 'Reads every inbound client message against the signed SOW and flags what is actually outside it, with a confidence score and the clause it relied on. The same request is never flagged twice.', icon: (<><rect x="4" y="4" width="26" height="26" rx="3" stroke="#1A5C3A" strokeWidth="1.4" /><path d="M10 17h14M17 10v14" stroke="#B91C1C" strokeWidth="1.4" /></>) },
  { title: 'SOW builder', desc: 'Deliverables, exclusions, milestones and revision limits, drafted from a raw brief, so “out of scope” is written down instead of implied.', icon: (<><path d="M8 4h14l6 6v20H8z" stroke="#1A5C3A" strokeWidth="1.4" /><path d="M13 15h9M13 20h9M13 25h5" stroke="#1A5C3A" strokeWidth="1.4" /></>) },
  { title: 'Change orders', desc: 'Priced and traceable to the exact flag that triggered them, so you review and send instead of drafting from a blank page.', icon: (<><path d="M6 27V9l11-5 11 5v18" stroke="#1A5C3A" strokeWidth="1.4" /><path d="M12 27v-9h10v9" stroke="#B91C1C" strokeWidth="1.4" /></>) },
  { title: 'Client signing portal', desc: 'No account required on their end. One link, one signature, and a copy in both inboxes the moment it is signed.', icon: (<><rect x="5" y="6" width="24" height="22" rx="2" stroke="#1A5C3A" strokeWidth="1.4" /><path d="M11 22l4-4 4 3 5-7" stroke="#B91C1C" strokeWidth="1.4" /></>) },
  { title: 'Roles and audit trail', desc: 'Decide who can send a SOW, approve a flag, or see contract value. Every decision is logged permanently, with who made it.', icon: (<><circle cx="17" cy="12" r="5" stroke="#1A5C3A" strokeWidth="1.4" /><path d="M6 28c1-6 6-9 11-9s10 3 11 9" stroke="#1A5C3A" strokeWidth="1.4" /></>) },
  { title: 'Billing that follows scope', desc: 'Milestones update the moment a change order is signed. What is billed always matches what was actually agreed.', icon: (<><rect x="5" y="8" width="24" height="17" rx="2" stroke="#1A5C3A" strokeWidth="1.4" /><path d="M5 13h24" stroke="#1A5C3A" strokeWidth="1.4" /><path d="M10 19h6" stroke="#B91C1C" strokeWidth="1.4" /></>) },
]

const PORTFOLIO_POINTS = [
  { title: 'Contract value at risk, in one number', desc: 'A severity-weighted estimate of what is exposed across every active project: open flags and granted exceptions, not just the ones you remember to check.' },
  { title: 'See where scope is actually stalling', desc: 'Stalled change orders and unresolved flags surface by project, so you know which client relationship needs attention before the renewal call, not after.' },
  { title: 'A trend, not a snapshot', desc: 'A daily rollup shows whether scope discipline is improving quarter over quarter, not just what is on fire today.' },
  { title: 'Only the people who should see it, do', desc: 'Gated on its own permission, separate from day-to-day project access, so it shows up for the people your org chart says should see it and no one else.' },
]

const FAQ = [
  { q: 'Won’t sending change orders make me look petty?', a: 'It’s the opposite more often than you’d think. A change order that points to a clause the client signed reads as professionalism, not pettiness. Most clients simply didn’t know the request was extra. And you decide every time whether to send one, waive it, or grant an exception.' },
  { q: 'What if Guardian gets it wrong?', a: 'Guardian shows a confidence score and the clause it relied on, so you can check its reasoning in seconds. Gray areas are marked borderline and left to you. You can also tune how eagerly it flags: conservative, medium, or aggressive.' },
  { q: 'Do my clients need to create an account?', a: 'No. They review and sign in a branded portal with no login. Guardian starts watching the project the moment they sign.' },
  { q: 'How do emails reach Guardian?', a: 'Each project gets its own Guardian address. Forward a client thread to it and anything outside the signed scope is flagged as it arrives.' },
  { q: 'What happens if I cancel?', a: 'Your workspace becomes read-only. You can still view and export your documents, and clients can still respond to anything you already sent. Nothing is deleted until you choose to delete it.' },
  { q: 'What if a plan won’t pay for itself for me?', a: 'Then we’ll tell you. The calculator above shows a plain “not yet” when the numbers don’t support a plan, rather than inflating the result.' },
]

export default function MarketingHome() {
  return (
    <div className={styles.page}>
      <MarketingHeader />

      <main id="top" className={styles.main}>
        {/* ================= HERO ================= */}
        <section className={styles.hero} id="hero">
          <div className={`${styles.wrap} ${styles.heroGrid}`}>
            <div>
              <p className={styles.eyebrow}>Scope governance for agencies</p>
              <h1>83% of change orders get approved. <em className={styles.redline}>{REDLINE_WORDS.map((word, i) => (
                <span key={word} className={styles.rlWord} style={{ ['--i' as string]: i } as React.CSSProperties}>{word}{i < REDLINE_WORDS.length - 1 ? ' ' : ''}</span>
              ))}</em></h1>
              <p className={styles.lede}>Scope creep isn&rsquo;t a client problem. It&rsquo;s a paperwork problem. ScopeGov&rsquo;s Guardian reads every client email against your signed Statement of Work, flags what&rsquo;s outside it, and drafts the change order while the ask is still fresh.</p>
              <div className={styles.ctaRow}>
                <Link className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLg}`} href="/signup">Start free trial</Link>
                <a className={`${styles.btn} ${styles.btnGhost} ${styles.btnLg}`} href="#pricing">What is your scope leak?</a>
              </div>
              <p className={styles.micro}>First SOW sent in about 10 minutes. Your clients never need an account to sign.</p>
              <div className={styles.heroProof} aria-label="Key results">
                <div><b>45,000+</b>SOWs issued</div>
                <div><b>30,000+</b>change orders drafted</div>
                <div><b>$36M</b>recovered for agencies</div>
              </div>
            </div>
            <HeroDemo />
          </div>
        </section>

        {/* ================= PROOF STRIP ================= */}
        <section className={styles.proof} id="proof" aria-labelledby="proof-h">
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>The evidence</p>
            <h2 id="proof-h">The ask isn&rsquo;t the problem. The silence is.</h2>
            <div className={styles.stats}>
              <Reveal className={styles.stat}><div className={styles.n}><CountUp target={45000} suffix="+" /></div><div className={styles.l}>Statements of Work issued through ScopeGov</div></Reveal>
              <Reveal className={styles.stat}><div className={styles.n}><CountUp target={30000} suffix="+" /></div><div className={styles.l}>change orders drafted from real client requests</div></Reveal>
              <Reveal className={styles.stat}><div className={styles.n}><CountUp target={83} suffix="%" /></div><div className={styles.l}>of those change orders approved by the client</div></Reveal>
              <Reveal className={styles.stat}><div className={styles.n}><CountUp target={36} prefix="$" suffix="M" /></div><div className={styles.l}>in work agencies would otherwise have given away</div></Reveal>
            </div>
            <details className={styles.howCount}>
              <summary>How we count these</summary>
              <p><b>Approved</b> means the client accepted the change order through the portal. <b>Recovered</b> is the combined value of approved change orders that began as a Guardian flag. About 24,900 approved change orders at an average of roughly $1,450 each. Figures cover all workspaces and are rounded down.</p>
            </details>
          </div>
        </section>


        {/* ================= HOW IT WORKS ================= */}
        <section className={styles.section} id="how" aria-labelledby="how-h">
          <div className={styles.wrap}>
            <Reveal className={styles.secHead}>
              <p className={styles.eyebrow}>How it works</p>
              <h2 id="how-h">One document, from brief to <em className={styles.accent}>bank transfer.</em></h2>
              <p className={styles.lede}>ScopeGov doesn&rsquo;t just store your SOW. It keeps it alive for the life of the project and enforces it automatically.</p>
            </Reveal>
            <Reveal className={styles.stages}>
              {LIFECYCLE.map((st, i) => (
                <div className={styles.stage} key={st.title}>
                  <span className={`${styles.stageTag} ${styles[st.tone === 'green' ? 'tagGreen' : st.tone === 'gold' ? 'tagGold' : 'tagNeutral']}`}>{i + 1} · {st.status}</span>
                  <h3>{st.title}</h3>
                  <p>{st.desc}</p>
                </div>
              ))}
            </Reveal>
          </div>
        </section>

        {/* ================= BEFORE / AFTER ================= */}
        <section className={styles.section} id="before-after" aria-labelledby="ba-h">
          <div className={styles.wrap}>
            <Reveal className={styles.secHead}>
              <p className={styles.eyebrow}>Before and after</p>
              <h2 id="ba-h">Same project. Same client. <em className={styles.accent}>Different Friday.</em></h2>
              <p className={styles.lede}>Nothing about the client changed. Nobody got nastier or braver. The only difference is that the request met a clause in the first five minutes instead of the last five.</p>
            </Reveal>
            <div className={styles.baGrid}>
              <Reveal as="article" className={`${styles.ba} ${styles.before}`}>
                <span className={styles.baTag}>Without ScopeGov</span>
                <h3>The favor that becomes a habit</h3>
                <ol className={styles.tl}>
                  <li><time>Tue 4:52 pm</time>&ldquo;Could you also&hellip;&rdquo; You say &ldquo;sure, no problem.&rdquo;</li>
                  <li className={styles.bad}><time>Tue 11:40 pm</time>You build it. It was supposed to take an hour.</li>
                  <li><time>Friday</time>The invoice goes out at the original quote.</li>
                  <li className={styles.bad}><time>Friday 5:30 pm</time>&ldquo;Wait, wasn&rsquo;t that included?&rdquo; Nobody can point to a line.</li>
                  <li className={styles.bad}><time>Next quarter</time>The relationship is a little cooler. The rate stays frozen.</li>
                </ol>
                <div className={styles.ledger} aria-label="Project ledger without ScopeGov">
                  <div className={styles.ledgerTitle}><span>Project ledger</span><span>$24,000 quote</span></div>
                  <div className={styles.lrow}><span>Work delivered</span><span className={styles.track}><span className={`${styles.fill} ${styles.work}`} style={w('100%')} /></span><span>$29,400</span></div>
                  <div className={styles.lrow}><span>Billed</span><span className={styles.track}><span className={`${styles.fill} ${styles.billed}`} style={w('81.6%')} /></span><span>$24,000</span></div>
                  <div className={styles.lrow}><span>Given away</span><span className={styles.track}><span className={`${styles.fill} ${styles.leak}`} style={w('18.4%')} /></span><span>$5,400</span></div>
                  <div className={styles.ledgerSum}><span>Unbilled work</span><span className={styles.big}>$5,400</span></div>
                </div>
              </Reveal>

              <Reveal as="article" className={`${styles.ba} ${styles.after}`}>
                <span className={styles.baTag}>With ScopeGov</span>
                <h3>The favor that becomes a clause</h3>
                <ol className={styles.tl}>
                  <li><time>Tue 4:52 pm</time>Same email. You forward it to the project&rsquo;s Guardian address.</li>
                  <li className={styles.good}><time>Tue 4:56 pm</time>Flagged: out of scope, SOW §3.2, 94% confidence.</li>
                  <li className={styles.good}><time>Tue 5:10 pm</time>Change order drafted, priced, and sent in one click.</li>
                  <li className={styles.good}><time>Wed 9:15 am</time>Client approves from the portal. No login, no thread to dig through.</li>
                  <li className={styles.good}><time>Friday</time>One invoice. Both lines. No awkward call.</li>
                </ol>
                <div className={styles.ledger} aria-label="Project ledger with ScopeGov">
                  <div className={styles.ledgerTitle}><span>Project ledger</span><span>$24,000 + $4,500 in COs</span></div>
                  <div className={styles.lrow}><span>Work delivered</span><span className={styles.track}><span className={`${styles.fill} ${styles.work}`} style={w('100%')} /></span><span>$29,400</span></div>
                  <div className={styles.lrow}><span>Billed</span><span className={styles.track}><span className={`${styles.fill} ${styles.billed}`} style={w('96.9%')} /></span><span>$28,500</span></div>
                  <div className={styles.lrow}><span>Given away</span><span className={styles.track}><span className={`${styles.fill} ${styles.leak}`} style={w('3.1%')} /></span><span>$900</span></div>
                  <div className={styles.ledgerSum}><span>Recovered</span><span className={styles.big}>+$4,500</span></div>
                </div>
              </Reveal>
            </div>
            <p className={styles.illustrative}>Illustrative project. Your numbers are in the calculator below.</p>
          </div>
        </section>

        {/* ================= GUARDIAN ================= */}
        <section className={`${styles.section} ${styles.guardian}`} id="guardian" aria-labelledby="g-h">
          <div className={styles.wrap}>
            <Reveal className={styles.secHead}>
              <p className={styles.eyebrow}>Guardian</p>
              <h2 id="g-h">Guardian doesn&rsquo;t have an opinion about your client. <em className={styles.accent}>It has a citation.</em></h2>
              <p className={styles.lede}>That&rsquo;s why the conversation stops being awkward. You&rsquo;re not saying &ldquo;I feel this is extra.&rdquo; You&rsquo;re pointing at a clause your client already signed. Pick a message and watch it work.</p>
            </Reveal>

            <Reveal className={styles.gGrid}>
              <GuardianDemo />
            </Reveal>

            <div className={styles.weapons}>
              <Reveal className={styles.weapon}>
                <div className={styles.ic} aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5 2.5h7l3.5 3.5v11.5H5V2.5Z" stroke="#1A5C3A" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8 10h5M8 13h5" stroke="#1A5C3A" strokeWidth="1.6" strokeLinecap="round" /></svg></div>
                <h3>The citation</h3>
                <p>Every flag points to the exact clause in the signed SOW. It&rsquo;s evidence you can forward, not an argument you have to win.</p>
              </Reveal>
              <Reveal className={styles.weapon}>
                <div className={styles.ic} aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 14a7 7 0 1 1 14 0" stroke="#1A5C3A" strokeWidth="1.6" strokeLinecap="round" /><path d="m10 14 3.5-4.5" stroke="#1A5C3A" strokeWidth="1.6" strokeLinecap="round" /></svg></div>
                <h3>The confidence score</h3>
                <p>Clear cases are flagged. Gray areas come to you marked as borderline. Guardian surfaces the decision. It never makes it for you.</p>
                <div className={styles.sens} role="img" aria-label="Sensitivity options: conservative, medium, aggressive"><span>Conservative</span><span className={styles.on}>Medium</span><span>Aggressive</span></div>
              </Reveal>
              <Reveal className={styles.weapon}>
                <div className={styles.ic} aria-hidden="true"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4 16l.8-3.6L13.6 3.6a1.6 1.6 0 0 1 2.3 0l.5.5a1.6 1.6 0 0 1 0 2.3L7.6 15.2 4 16Z" stroke="#1A5C3A" strokeWidth="1.6" strokeLinejoin="round" /></svg></div>
                <h3>The draft</h3>
                <p>The change order is already written and priced when you open the flag. You change a number if you want to, and send.</p>
              </Reveal>
            </div>
          </div>
        </section>


        {/* ================= FEATURES ================= */}
        <section className={styles.section} id="features" aria-labelledby="feat-h">
          <div className={styles.wrap}>
            <Reveal className={styles.secHead}>
              <p className={styles.eyebrow}>The docket</p>
              <h2 id="feat-h">Everything between &ldquo;we agreed on this&rdquo; and <em className={styles.accent}>&ldquo;please pay for that.&rdquo;</em></h2>
              <p className={styles.lede}>Replaces your proposal doc, your SOW folder and ad-hoc invoicing. It sits alongside whatever runs day-to-day delivery (Asana, ClickUp, Linear), since that is for execution, not the contract of record.</p>
            </Reveal>
            <Reveal className={styles.featGrid}>
              {FEATURES.map((f) => (
                <div className={styles.feat} key={f.title}>
                  <svg viewBox="0 0 34 34" width="34" height="34" fill="none" aria-hidden="true">{f.icon}</svg>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
              ))}
            </Reveal>
          </div>
        </section>

        {/* ================= PORTFOLIO ================= */}
        <section className={`${styles.section} ${styles.portfolio}`} id="portfolio" aria-labelledby="pf-h">
          <div className={styles.wrap}>
            <Reveal className={styles.secHead}>
              <p className={styles.eyebrow}>Portfolio</p>
              <h2 id="pf-h">One dashboard for every scope decision across your <em className={styles.accent}>book of business.</em></h2>
              <p className={styles.lede}>Running more than one project at a time turns scope creep into a rounding error you can&rsquo;t see project by project. Portfolio rolls every flag, every stalled change order and every dollar at risk into a single view.</p>
            </Reveal>
            <div className={styles.pfGrid}>
              <Reveal className={styles.pPoints}>
                {PORTFOLIO_POINTS.map((p) => (
                  <div className={styles.pPoint} key={p.title}>
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 17V9M8.5 17V4M14 17v-6.5M17 3v14" stroke="#1A5C3A" strokeWidth="1.5" strokeLinecap="round" /></svg>
                    <div><h3>{p.title}</h3><p>{p.desc}</p></div>
                  </div>
                ))}
              </Reveal>
              <Reveal>
                <div className={styles.panel} role="img" aria-label="Sample portfolio view: $14,200 contract value at risk">
                  <div className={styles.panelH}><span>Portfolio · this month</span><span>Sample</span></div>
                  <div className={styles.pfBody}>
                    <div className={styles.pfTotal}><b>$14,200</b><span>Contract value at risk</span></div>
                    {[['High', '69%', '$9,800', 'var(--red)'], ['Medium', '22%', '$3,100', 'var(--gold-fill)'], ['Low', '9%', '$1,300', 'var(--green-mid)']].map(([l, wd, v, c]) => (
                      <div className={styles.pfBar} key={l}><span>{l}</span><span className={styles.track}><span className={styles.pfFill} style={{ width: wd, background: c }} /></span><b>{v}</b></div>
                    ))}
                    <ul className={styles.pfRows}>
                      <li><span>Willow &amp; Finch · Brand Refresh</span><span>2 open flags</span></li>
                      <li><span>Marchetti &amp; Co · Website</span><span>1 stalled CO</span></li>
                      <li><span>Petra Goods · Rebrand</span><span>1 open flag</span></li>
                    </ul>
                  </div>
                </div>
                <p className={styles.illustrative}>Sample figures for illustration.</p>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ================= TOP CATEGORIES ================= */}
        <section className={styles.section} id="creep" aria-labelledby="cat-h">
          <ScopeCategories />
        </section>

        {/* ================= STORIES ================= */}
        <section className={`${styles.section} ${styles.stories}`} id="stories" aria-labelledby="st-h">
          <div className={styles.wrap}>
            <Reveal className={styles.secHead}>
              <p className={styles.eyebrow}>What agencies say</p>
              <h2 id="st-h">Stories from the other side of <em className={styles.accent}>the awkward email.</em></h2>
              <p className={styles.lede}>Every agency has the email. These are what happened after they stopped ignoring it.</p>
            </Reveal>

            <Reveal as="article" className={`${styles.story} ${styles.storyLead}`}>
              <div className={styles.who}>Our story</div>
              <h3>The favor that cost us a month.</h3>
              <details open>
                <summary>Why we built ScopeGov</summary>
                <div className={styles.narr}>
                  <p>It began with a text that said &ldquo;quick one.&rdquo; A logo resize, we thought. By Friday it was a brand system. We did it because saying no felt like losing the client, and the invoice never mentioned it.</p>
                  <p>The SOW had been perfect on day one and useless on day nine. That gap, between what was agreed and what was actually happening, is the whole product.</p>
                  <p className={styles.moral}>So we made the contract answer back, with a citation instead of an opinion.</p>
                </div>
              </details>
            </Reveal>

            <div className={styles.storyGrid}>
              <Reveal as="article" className={styles.story}>
                <div className={styles.who}>Founder · 7-person brand studio</div>
                <h3>The $11,400 we used to call &ldquo;goodwill.&rdquo;</h3>
                <div className={styles.metrics}><span>+$11,400 in 90 days</span><span>9 of 11 COs approved</span></div>
                <blockquote>&ldquo;I thought asking would make us look petty. It turned out the clients just hadn&rsquo;t known.&rdquo;</blockquote>
                <details>
                  <summary>Read the story</summary>
                  <div className={styles.narr}>
                    <p>Maya ran her studio on one rule: never nickel-and-dime a client. So when a founder emailed, &ldquo;Could you also pull together a quick investor deck?&rdquo; she said yes at 11:40 pm, the way she always did. The month before, the studio had given away 62 hours. She only knew because someone finally counted.</p>
                    <p>In week two on ScopeGov, Guardian flagged that exact kind of email four minutes after she forwarded it, pointing to the line in the SOW that excluded presentations. She sent a $1,800 change order, bracing for a fight.</p>
                    <p>The reply came in an hour: &ldquo;Of course. Honestly, I didn&rsquo;t know that was a separate thing. Thank you for telling me.&rdquo;</p>
                    <p className={styles.moral}>The client was never the problem. The ambiguity was. Nothing is free anymore, until someone writes down that it&rsquo;s free.</p>
                  </div>
                </details>
              </Reveal>

              <Reveal as="article" className={styles.story}>
                <div className={styles.who}>Freelance developer · solo</div>
                <h3>The invoice I was afraid to send.</h3>
                <div className={styles.metrics}><span>12 of 14 COs approved</span><span>~6 hrs a week reclaimed</span></div>
                <blockquote>&ldquo;I didn&rsquo;t get braver. I got evidence.&rdquo;</blockquote>
                <details>
                  <summary>Read the story</summary>
                  <div className={styles.narr}>
                    <p>Daniel wrote off about six hours a week in &ldquo;tiny&rdquo; things: a plugin here, an integration there. His first Guardian flag was a payment gateway that wasn&rsquo;t in the SOW. &ldquo;It&rsquo;s just an API key,&rdquo; the client had written.</p>
                    <p>His stomach dropped as he hit send on a $450 change order. The client approved from their phone in two hours and added: &ldquo;Send me the invoice. And thanks for being upfront.&rdquo;</p>
                    <p>Eight weeks later he had fourteen flags and twelve approvals on a single dashboard. The next quarter, he raised his rates. Not because he felt bolder, but because he finally had the data to back it up.</p>
                    <p className={styles.moral}>Fear was never about the client saying no. It was about not knowing what they&rsquo;d say.</p>
                  </div>
                </details>
              </Reveal>

              <Reveal as="article" className={styles.story}>
                <div className={styles.who}>Account director · 24-person agency</div>
                <h3>We saw the churn coming before the client did.</h3>
                <div className={styles.metrics}><span>$38,000 recovered in 6 months</span><span>Account renewed higher</span></div>
                <blockquote>&ldquo;Scope creep isn&rsquo;t a billing problem. It&rsquo;s an early-warning system.&rdquo;</blockquote>
                <details>
                  <summary>Read the story</summary>
                  <div className={styles.narr}>
                    <p>Priya opened the scope dashboard before a renewal and noticed one client had three stalled change orders and a climbing flag count. Normally she&rsquo;d have run the usual &ldquo;everything&rsquo;s going great&rdquo; call.</p>
                    <p>Instead she called early and said, &ldquo;Your team keeps asking for things outside our agreement, and ours keep quietly saying yes. Let&rsquo;s fix how we work together.&rdquo; The client admitted they&rsquo;d never been sure what they were actually buying.</p>
                    <p>They re-scoped into a retainer with clear monthly hours. Over six months the agency recovered $38,000 in approved change orders, and the account renewed at a higher rate.</p>
                    <p className={styles.moral}>The data didn&rsquo;t just protect the margin. It showed which relationship needed a conversation first.</p>
                  </div>
                </details>
              </Reveal>
            </div>

            <div className={styles.quotes}>
              <Reveal as="figure" className={styles.q}><p>&ldquo;Guardian said &lsquo;out of scope, clause 2.1.&rsquo; I forwarded it. No awkwardness.&rdquo;</p><span>Studio owner, 4-person design shop</span></Reveal>
              <Reveal as="figure" className={styles.q}><p>&ldquo;It&rsquo;s the first tool that made the contract feel like it was on my side.&rdquo;</p><span>Founder, boutique web agency</span></Reveal>
              <Reveal as="figure" className={styles.q}><p>&ldquo;My clients sign in thirty seconds and never create an account.&rdquo;</p><span>Freelance brand designer</span></Reveal>
              <Reveal as="figure" className={styles.q}><p>&ldquo;The change order drafted itself. I changed one number.&rdquo;</p><span>Project lead, 12-person agency</span></Reveal>
              <Reveal as="figure" className={styles.q}><p>&ldquo;I stopped doing the math at midnight.&rdquo;</p><span>Solo developer</span></Reveal>
              <Reveal as="figure" className={styles.q}><p>&ldquo;We finally know which clients are expensive.&rdquo;</p><span>Operations manager, content agency</span></Reveal>
            </div>
            <p className={styles.illustrative}>The stories and quotes above are illustrative examples, not statements from named customers.</p>
          </div>
        </section>

        {/* ================= PRICING ================= */}
        <section className={styles.section} id="pricing" aria-labelledby="pr-h">
          <PricingSection />
        </section>

        {/* ================= FAQ ================= */}
        <section className={`${styles.section} ${styles.faqSection}`} id="faq" aria-labelledby="faq-h">
          <div className={`${styles.wrap} ${styles.faqGrid}`}>
            <Reveal>
              <p className={styles.eyebrow}>Fair questions</p>
              <h2 id="faq-h">What agencies ask <em className={styles.accent}>before they start.</em></h2>
            </Reveal>
            <Reveal className={styles.faq}>
              {FAQ.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </Reveal>
          </div>
        </section>

        {/* ================= FINAL CTA ================= */}
        <section className={styles.final} aria-labelledby="fin-h">
          <Reveal className={styles.wrap}>
            <h2 id="fin-h">The next &ldquo;quick favor&rdquo; is already in someone&rsquo;s inbox.</h2>
            <p>Make it a clause. File your first Statement of Work in about ten minutes.</p>
            <div className={styles.ctaRow}>
              <Link className={`${styles.btn} ${styles.btnLight} ${styles.btnLg}`} href="/signup">Start free trial</Link>
              <a className={`${styles.btn} ${styles.btnGhost} ${styles.btnLg}`} href="#pricing">Estimate my scope leak</a>
            </div>
            <p className={styles.micro}>Free trial. Clients never need an account.</p>
          </Reveal>
        </section>
      </main>

      <MarketingFooter />
      <MobileCta />
    </div>
  )
}
