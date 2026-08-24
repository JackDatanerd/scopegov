import Link from 'next/link'
import styles from '@/styles/marketing.module.css'
import MarketingHeader from './MarketingHeader'
import MarketingFooter from './MarketingFooter'
import Reveal from './Reveal'
import HeroDocMock from './HeroDocMock'
import GuardianTryIt from './GuardianTryIt'

const DOSSIER_ITEMS = [
  {
    tag: 'Exhibit D',
    title: 'Guardian AI',
    desc: 'Reads every inbound client message against the signed SOW and flags what\u2019s actually outside it \u2014 with a confidence score, not a hunch.',
    icon: (
      <>
        <rect x="4" y="4" width="26" height="26" rx="3" stroke="#1A5C3A" strokeWidth="1.2" />
        <path d="M10 17h14M17 10v14" stroke="#B91C1C" strokeWidth="1.2" />
      </>
    ),
  },
  {
    tag: 'Exhibit E',
    title: 'SOW builder',
    desc: 'Deliverables, exclusions, milestones, and revision limits \u2014 drafted from a raw brief, so \u201cout of scope\u201d is written down, not implied.',
    icon: (
      <>
        <path d="M8 4h14l6 6v20H8z" stroke="#1A5C3A" strokeWidth="1.2" />
        <path d="M13 15h9M13 20h9M13 25h5" stroke="#1A5C3A" strokeWidth="1.2" />
      </>
    ),
  },
  {
    tag: 'Exhibit F',
    title: 'Change orders',
    desc: 'Priced and traceable to the exact flag that triggered them, so you review and send instead of drafting from a blank page.',
    icon: (
      <>
        <path d="M6 27V9l11-5 11 5v18" stroke="#1A5C3A" strokeWidth="1.2" />
        <path d="M12 27v-9h10v9" stroke="#B91C1C" strokeWidth="1.2" />
      </>
    ),
  },
  {
    tag: 'Exhibit G',
    title: 'Client signing portal',
    desc: 'No account required on their end. One link, one signature, a copy in both inboxes the moment it\u2019s signed.',
    icon: (
      <>
        <rect x="5" y="6" width="24" height="22" rx="2" stroke="#1A5C3A" strokeWidth="1.2" />
        <path d="M11 22l4-4 4 3 5-7" stroke="#B91C1C" strokeWidth="1.2" />
      </>
    ),
  },
  {
    tag: 'Exhibit H',
    title: 'Roles & audit trail',
    desc: 'Decide who can send a SOW, approve a flag, or see contract value. Every decision is logged, permanently and by whom.',
    icon: (
      <>
        <circle cx="17" cy="12" r="5" stroke="#1A5C3A" strokeWidth="1.2" />
        <path d="M6 28c1-6 6-9 11-9s10 3 11 9" stroke="#1A5C3A" strokeWidth="1.2" />
      </>
    ),
  },
  {
    tag: 'Exhibit I',
    title: 'Billing that follows scope',
    desc: 'Milestones update the moment a change order is signed. What\u2019s billed always matches what was actually agreed.',
    icon: (
      <>
        <rect x="5" y="8" width="24" height="17" rx="2" stroke="#1A5C3A" strokeWidth="1.2" />
        <path d="M5 13h24" stroke="#1A5C3A" strokeWidth="1.2" />
        <path d="M10 19h6" stroke="#B91C1C" strokeWidth="1.2" />
      </>
    ),
  },
]

const LIFECYCLE = [
  { status: 'Drafted', statusClass: styles.stageStatusNeutral, title: 'Brief in, SOW out', desc: 'Paste a raw brief or client email. ScopeGov drafts a full Statement of Work \u2014 deliverables, exclusions, payment terms \u2014 in under 20 seconds.' },
  { status: 'Signed', statusClass: styles.stageStatusGreen, title: 'Client signs, scope locks', desc: 'Your client reviews and signs in a branded portal \u2014 no account needed. The moment they sign, Guardian activates on the project.' },
  { status: 'Monitored', statusClass: styles.stageStatusGold, title: 'Every email, checked', desc: 'Forward client threads to your project\u2019s Guardian address. Anything outside the signed scope gets flagged the moment it arrives.' },
  { status: 'Recovered', statusClass: styles.stageStatusGreen, title: 'Flag becomes revenue', desc: 'One click turns a flag into a change order, sent for signature. Accepted work updates the contract value automatically.' },
]

const GUARDIAN_POINTS = [
  { title: 'Reads what\u2019s actually signed', desc: 'Guardian checks every request against the exact deliverables and exclusions in your signed SOW \u2014 not a vague sense of \u201creasonable.\u201d' },
  { title: 'Tunable sensitivity', desc: 'Conservative, medium, or aggressive \u2014 choose how eagerly Guardian flags borderline requests, per workspace.' },
  { title: 'Never flags the same thing twice', desc: 'Duplicate detection means a thread with five reply-alls doesn\u2019t become five separate flags.' },
  { title: 'You always have the final say', desc: 'Resolve, grant an exception, or draft a change order \u2014 Guardian surfaces the decision, it never makes it for you.' },
]

const PORTFOLIO_POINTS = [
  { title: 'Contract value at risk, in one number', desc: 'A severity-weighted estimate of what\u2019s exposed across every active project \u2014 open flags and granted exceptions, not just the ones you remember to check.' },
  { title: 'See where scope is actually stalling', desc: 'Stalled change orders and unresolved flags surface by project, so you know which client relationship needs attention before the renewal call, not after.' },
  { title: 'A trend, not a snapshot', desc: 'A daily rollup means you can see whether scope discipline is improving quarter over quarter \u2014 not just what\u2019s on fire today.' },
  { title: 'Only the people who should see it, do', desc: 'Gated on its own permission, separate from day-to-day project access \u2014 so it shows up for the people your org chart says should see it, and no one else.' },
]

const PRICING_ROWS: { label: string; values: [string, string, string, string] }[] = [
  { label: 'Seats', values: ['1', '2', '4', '10'] },
  { label: 'Active projects', values: ['2', '5', 'Unlimited', 'Unlimited'] },
  { label: 'Guardian monitoring', values: ['check', 'check', 'check', 'check'] },
  { label: 'Full SOW history', values: ['Last 10', 'check', 'check', 'check'] },
  { label: 'Custom roles & permissions', values: ['dash', 'dash', 'check', 'check'] },
]

function Cell({ value }: { value: string }) {
  if (value === 'check') return <span className={styles.check}>&#10003;</span>
  if (value === 'dash') return <span className={styles.dash}>&mdash;</span>
  return <>{value}</>
}

export default function MarketingHome() {
  return (
    <div className={styles.page}>
      <div className={styles.grain} />
      <MarketingHeader />

      {/* ================= HERO ================= */}
      <section className={styles.hero}>
        <div className={`${styles.wrap} ${styles.heroGrid}`}>
          <div>
            <div className={styles.eyebrow}>Scope governance for agencies</div>
            <h1 className={styles.h1}>
              Every &ldquo;quick favor&rdquo; is now a clause &mdash;
              <br />
              <em>and it&rsquo;s on the invoice.</em>
            </h1>
            <p className={styles.heroSub}>
              ScopeGov turns your Statement of Work into a living contract. Guardian reads every client email against it, flags what&rsquo;s out of scope, and drafts the change order before the work even starts.
            </p>
            <div className={styles.heroCtas}>
              <Link href="/signup" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLg}`}>Start free trial</Link>
              <a href="#guardian" className={styles.heroLink}>See Guardian in action &rarr;</a>
            </div>
            <p className={styles.trustLine}>
              14-DAY TRIAL &middot; NO CARD REQUIRED &middot; <strong>YOU APPROVE EVERY FLAG</strong> &mdash; GUARDIAN NEVER CONTACTS A CLIENT ON ITS OWN
            </p>
          </div>
          <HeroDocMock />
        </div>
      </section>

      {/* ================= PROBLEM / EXHIBITS ================= */}
      <section className={styles.problem} id="product">
        <div className={styles.wrap}>
          <Reveal as="p" className={styles.problemLede}>
            Scope creep doesn&rsquo;t feel like theft. It feels like helping a client out. That&rsquo;s exactly why it&rsquo;s never on the invoice &mdash; and why agencies write off thousands in unbilled work every quarter without ever seeing it happen.
          </Reveal>

          <Reveal className={styles.exhibits}>
            <div className={styles.exhibit}>
              <div className={styles.exhibitTag}>Exhibit A &mdash; Industry average</div>
              <div className={styles.exhibitNum}>23<span>%</span></div>
              <div className={styles.exhibitDesc}>of billable hours on a typical project fall outside the original SOW &mdash; and go unbilled because no one flagged them in time.</div>
            </div>
            <div className={styles.exhibit}>
              <div className={styles.exhibitTag}>Exhibit B &mdash; Where it starts</div>
              <div className={styles.exhibitNum}>Email</div>
              <div className={styles.exhibitDesc}>Almost all scope creep begins as a casual client request in an inbox &mdash; never in a formal change request. By the time it&rsquo;s noticed, it&rsquo;s already been done.</div>
            </div>
            <div className={styles.exhibit}>
              <div className={styles.exhibitTag}>Exhibit C &mdash; What recovery looks like</div>
              <div className={styles.exhibitNum}>61<span>%</span></div>
              <div className={styles.exhibitDesc}>of flagged scope creep converts into a paid change order when it&rsquo;s caught immediately &mdash; versus under 10% when raised after delivery.</div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================= HOW IT WORKS ================= */}
      <section>
        <div className={styles.wrap}>
          <Reveal className={styles.sectionHd}>
            <div className={styles.sectionEyebrow}>How it works</div>
            <h2 className={styles.h2}>One document, from brief to bank transfer.</h2>
            <p className={styles.sectionSub}>ScopeGov doesn&rsquo;t just store your SOW &mdash; it keeps it alive for the life of the project, and enforces it automatically.</p>
          </Reveal>

          <Reveal className={styles.lifecycle}>
            {LIFECYCLE.map((s, i) => (
              <div className={styles.stage} key={s.title}>
                <div className={`${styles.stageStatus} ${s.statusClass}`}>{s.status}</div>
                <div className={styles.stageTitle}>{s.title}</div>
                <div className={styles.stageDesc}>{s.desc}</div>
                {i < LIFECYCLE.length - 1 && <div className={styles.stageConnector}>&rarr;</div>}
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ================= DOSSIER / FEATURES ================= */}
      <section className={styles.dossier}>
        <div className={styles.wrap}>
          <Reveal className={styles.sectionHd}>
            <div className={styles.sectionEyebrow}>The docket</div>
            <h2 className={styles.h2}>Everything between &ldquo;we agreed on this&rdquo; and &ldquo;please pay for that.&rdquo;</h2>
            <p className={styles.sectionSub}>Replaces your proposal doc, your SOW folder, and ad-hoc invoicing. Sits alongside whatever runs day-to-day delivery &mdash; Asana, ClickUp, Linear &mdash; since that&rsquo;s for execution, not the contract of record.</p>
          </Reveal>

          <Reveal className={styles.dossierGrid}>
            {DOSSIER_ITEMS.map((item) => (
              <div className={styles.dossierCard} key={item.title}>
                <svg className={styles.dossierIcon} viewBox="0 0 34 34" fill="none">{item.icon}</svg>
                <div className={styles.dossierTag}>{item.tag}</div>
                <h3>{item.title}</h3>
                <p>{item.desc}</p>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* ================= GUARDIAN ================= */}
      <section className={styles.guardianSection} id="guardian">
        <div className={styles.wrap}>
          <Reveal className={styles.sectionHd}>
            <div className={styles.sectionEyebrow}>Guardian</div>
            <h2 className={styles.h2}>The scope reviewer who never gets tired of reading email.</h2>
            <p className={styles.sectionSub}>Guardian reads every message against your signed SOW and tells you, precisely, whether it&rsquo;s covered &mdash; with a confidence score, not a guess.</p>
          </Reveal>

          <div className={styles.guardianGrid}>
            <Reveal className={styles.guardianPoints}>
              {GUARDIAN_POINTS.map((p, i) => (
                <div className={styles.gPoint} key={p.title}>
                  <div className={styles.gNum}>{String(i + 1).padStart(2, '0')}</div>
                  <div>
                    <div className={styles.gPointTitle}>{p.title}</div>
                    <div className={styles.gPointDesc}>{p.desc}</div>
                  </div>
                </div>
              ))}
            </Reveal>

            <Reveal>
              <GuardianTryIt />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================= PORTFOLIO ================= */}
      <section className={styles.portfolioSection} id="portfolio">
        <div className={styles.wrap}>
          <Reveal className={styles.sectionHd}>
            <div className={styles.sectionEyebrow}>Portfolio</div>
            <h2 className={styles.h2}>One dashboard for every scope decision across your book of business.</h2>
            <p className={styles.sectionSub}>Running more than one project at a time turns scope creep into a rounding error you can&rsquo;t see project by project. Portfolio rolls every flag, every stalled change order, and every dollar at risk into a single view.</p>
          </Reveal>

          <div className={styles.portfolioGrid}>
            <Reveal className={styles.portfolioPoints}>
              {PORTFOLIO_POINTS.map((p) => (
                <div className={styles.pPoint} key={p.title}>
                  <svg className={styles.pIcon} viewBox="0 0 20 20" fill="none">
                    <path d="M3 17V9M8.5 17V4M14 17v-6.5M17 3v14" stroke="#1A5C3A" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                  <div>
                    <div className={styles.pPointTitle}>{p.title}</div>
                    <div className={styles.pPointDesc}>{p.desc}</div>
                  </div>
                </div>
              ))}
            </Reveal>

            <Reveal>
              <div className={styles.ledger}>
                <div className={styles.ledgerHead}>
                  <div className={styles.ledgerHeadLbl}>Portfolio &middot; This month</div>
                </div>
                <div className={styles.ledgerTotal}>
                  <div className={styles.ledgerTotalNum}>$14,200</div>
                  <div className={styles.ledgerTotalLbl}>Contract value at risk</div>
                </div>
                <div className={styles.ledgerBars}>
                  <div className={styles.ledgerBarRow}>
                    <div className={styles.ledgerBarLabel}>High</div>
                    <div className={styles.ledgerBarTrack}><div className={styles.ledgerBarFill} style={{ width: '69%', background: '#F09696' }} /></div>
                    <div className={styles.ledgerBarVal}>$9,800</div>
                  </div>
                  <div className={styles.ledgerBarRow}>
                    <div className={styles.ledgerBarLabel}>Medium</div>
                    <div className={styles.ledgerBarTrack}><div className={styles.ledgerBarFill} style={{ width: '22%', background: '#E4C97A' }} /></div>
                    <div className={styles.ledgerBarVal}>$3,100</div>
                  </div>
                  <div className={styles.ledgerBarRow}>
                    <div className={styles.ledgerBarLabel}>Low</div>
                    <div className={styles.ledgerBarTrack}><div className={styles.ledgerBarFill} style={{ width: '9%', background: '#8FD9AE' }} /></div>
                    <div className={styles.ledgerBarVal}>$1,300</div>
                  </div>
                </div>
                <div className={styles.ledgerRows}>
                  <div className={styles.ledgerRow}>
                    <div className={styles.ledgerRowName}>Willow &amp; Finch &mdash; Brand Refresh</div>
                    <div className={styles.ledgerRowMeta}>2 open flags</div>
                  </div>
                  <div className={styles.ledgerRow}>
                    <div className={styles.ledgerRowName}>Marchetti &amp; Co &mdash; Website</div>
                    <div className={styles.ledgerRowMeta}>1 stalled CO</div>
                  </div>
                  <div className={styles.ledgerRow}>
                    <div className={styles.ledgerRowName}>Petra Goods &mdash; Rebrand</div>
                    <div className={styles.ledgerRowMeta}>1 open flag</div>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================= ORIGIN NOTE ================= */}
      <section className={styles.origin}>
        <div className={styles.wrap}>
          <div className={styles.originInner}>
            <Reveal>
              <div className={styles.eyebrow}>Why we built this</div>
              <p className={styles.originQuote}>
                Every agency we&rsquo;ve talked to has the same story &mdash; a client&rsquo;s &ldquo;quick ask,&rdquo; a late night doing it anyway, and no clean way to bill for it without sounding petty. ScopeGov is the tool we wished we&rsquo;d had before that conversation, not after.
              </p>
            </Reveal>
            <Reveal className={styles.originStats}>
              <div className={styles.originStat}>
                <div className={styles.originStatNum}>10 min</div>
                <div className={styles.originStatLbl}>Typical setup time, first SOW to sent</div>
              </div>
              <div className={styles.originStat}>
                <div className={styles.originStatNum}>1 click</div>
                <div className={styles.originStatLbl}>From a flagged message to a priced change order</div>
              </div>
              <div className={styles.originStat}>
                <div className={styles.originStatNum}>0</div>
                <div className={styles.originStatLbl}>Client logins required to sign anything</div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================= TESTIMONIAL =================
          NOTE FOR REVIEW: this is placeholder social proof (fabricated name
          and company) standing in for the real thing until there's an
          actual customer quote to put here. Swap it — or remove the whole
          section — before this goes live; shipping a named quote from a
          customer that doesn't exist isn't something to launch with. */}
      <section className={styles.testimonial}>
        <div className={styles.wrap}>
          <Reveal className={styles.affidavit}>
            <div className={styles.affidavitMark}>&ldquo;</div>
            <p className={styles.affidavitQuote}>
              We used to eat scope creep as a cost of doing business. Last quarter we billed an extra $14,000 in change orders we would never have caught before &mdash; from work we were already doing for free.
            </p>
            <div className={styles.affidavitSig}>
              <div className={styles.affidavitAvatar}>M</div>
              <div style={{ textAlign: 'left' }}>
                <div className={styles.affidavitName}>Marcus Chen</div>
                <div className={styles.affidavitRole}>Founder, Fieldnote Studio &middot; placeholder quote</div>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================= PRICING ================= */}
      <section className={styles.pricing} id="pricing">
        <div className={styles.wrap}>
          <Reveal className={styles.sectionHd}>
            <div className={styles.sectionEyebrow}>Pricing</div>
            <h2 className={styles.h2}>Priced like the tool that pays for itself on the first flag.</h2>
            <p className={styles.sectionSub}>Every plan includes unlimited Guardian monitoring and AI-drafted SOWs. Upgrade for more seats and full document history.</p>
          </Reveal>

          <Reveal className={styles.rateCard}>
            <div className={`${styles.rateRow} ${styles.rateRowHead}`}>
              <div className={styles.rateLabelCell} />
              <div>
                <div className={styles.planName}>Solo</div>
                <div className={styles.planPrice}>$39<span>/mo</span></div>
              </div>
              <div>
                <div className={styles.planName}>Starter</div>
                <div className={styles.planPrice}>$99<span>/mo</span></div>
              </div>
              <div className={styles.planFeatured}>
                <div className={styles.planName}>Pro</div>
                <div className={styles.planPrice}>$249<span>/mo</span></div>
              </div>
              <div>
                <div className={styles.planName}>Agency</div>
                <div className={styles.planPrice}>$399<span>/mo</span></div>
              </div>
            </div>

            {PRICING_ROWS.map((row) => (
              <div className={styles.rateRow} key={row.label}>
                <div className={styles.rateLabelCell}>{row.label}</div>
                {row.values.map((v, i) => (
                  <div className={styles.rateCell} key={i}><Cell value={v} /></div>
                ))}
              </div>
            ))}

            <div className={styles.rateCtaRow}>
              <div />
              <div><Link href="/signup?plan=solo" className={`${styles.btn} ${styles.btnGhost} ${styles.btnFull}`}>Start trial</Link></div>
              <div><Link href="/signup?plan=starter" className={`${styles.btn} ${styles.btnGhost} ${styles.btnFull}`}>Start trial</Link></div>
              <div><Link href="/signup?plan=pro" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnFull}`}>Start trial</Link></div>
              <div><Link href="/signup?plan=agency" className={`${styles.btn} ${styles.btnGhost} ${styles.btnFull}`}>Start trial</Link></div>
            </div>
          </Reveal>
          <p className={styles.pricingNote}>Prices in USD, billed monthly. Annual billing available at checkout. Cancel anytime &mdash; you keep read access to your SOWs and change orders for 90 days after cancellation.</p>
        </div>
      </section>

      {/* ================= FINAL CTA ================= */}
      <section className={styles.finalCta}>
        <div className={`${styles.wrap} ${styles.finalCtaInner}`}>
          <h2 className={styles.h2}>File your first Statement of Work.</h2>
          <p className={styles.finalCtaP}>14 days free. No card required. Your first SOW is drafted before the trial even asks for one.</p>
          <Link href="/signup" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLg}`}>Start free trial</Link>
        </div>
      </section>

      <MarketingFooter />
    </div>
  )
}
