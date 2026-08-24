import styles from '@/styles/legal.module.css'

export const metadata = {
  title: 'Terms of Service',
  description: 'The agreement governing use of ScopeGov.',
}

export default function TermsPage() {
  return (
    <article>
      <span className={styles.docBadge}>Legal &middot; Terms</span>
      <h1 className={styles.title}>Terms of Service</h1>
      <p className={styles.meta}>Last updated: <span className={styles.placeholder}>[DATE OF PUBLICATION]</span> &middot; Effective on publication</p>

      <div className={styles.reviewNote}>
        <strong>Draft for internal review.</strong> Written to match the product as built — trial terms, plan
        names, and the change-order/e-signature flow all reflect what&rsquo;s actually in the app. It is not
        legal advice. The liability cap, governing-law, and dispute-resolution sections in particular should
        be reviewed by a lawyer familiar with Kenyan and cross-border SaaS contracts before this is published.
      </div>

      <nav className={styles.toc}>
        <div className={styles.tocTitle}>On this page</div>
        <ul className={styles.tocList}>
          <li><a href="#acceptance">1. Acceptance</a></li>
          <li><a href="#the-service">2. The service</a></li>
          <li><a href="#accounts">3. Accounts &amp; workspaces</a></li>
          <li><a href="#your-content">4. Your content</a></li>
          <li><a href="#guardian-ai">5. Guardian &amp; AI features</a></li>
          <li><a href="#signing">6. Client signing</a></li>
          <li><a href="#plans-billing">7. Plans &amp; billing</a></li>
          <li><a href="#acceptable-use">8. Acceptable use</a></li>
          <li><a href="#termination">9. Suspension &amp; termination</a></li>
          <li><a href="#warranty">10. Disclaimer of warranty</a></li>
          <li><a href="#liability">11. Limitation of liability</a></li>
          <li><a href="#indemnity">12. Indemnity</a></li>
          <li><a href="#governing-law">13. Governing law</a></li>
          <li><a href="#changes">14. Changes to these terms</a></li>
          <li><a href="#contact">15. Contact</a></li>
        </ul>
      </nav>

      <div className={styles.prose}>
        <h2 id="acceptance">1. Acceptance</h2>
        <p>
          These Terms are an agreement between you (or the agency you represent, &ldquo;you&rdquo;) and Saltern
          Studio Ltd., operating as ScopeGov (&ldquo;we,&rdquo; &ldquo;us&rdquo;), a company registered in{' '}
          <span className={styles.placeholder}>[Kenya / registration number]</span>. By creating an account
          or using scopegov.app or sign.scopegov.app, you agree to these Terms. If you&rsquo;re accepting on
          behalf of an organization, you&rsquo;re confirming you have authority to bind it.
        </p>

        <h2 id="the-service">2. The service</h2>
        <p>
          ScopeGov helps agencies draft Statements of Work, monitor client communication against them via
          Guardian, generate and route change orders for signature, and issue invoices tied to agreed
          milestones. We may add, change, or remove features over time; we&rsquo;ll try to give reasonable
          notice for anything that materially reduces what a paid plan includes.
        </p>

        <h2 id="accounts">3. Accounts &amp; workspaces</h2>
        <p>
          You&rsquo;re responsible for the accuracy of information you provide and for activity under your
          account. Workspace owners control who has access and what permissions they hold, including whether
          two-factor authentication is required for governance-level roles — we enforce that requirement
          technically once it applies, but the underlying access decisions are yours to make.
        </p>

        <h2 id="your-content">4. Your content</h2>
        <p>
          You own the Statements of Work, change orders, client records, and other content you put into
          ScopeGov (&ldquo;Your Content&rdquo;). You grant us a limited license to host, process, and display
          Your Content solely to provide the service to you — including sending it to the AI subprocessors
          described in our <a href="/legal/privacy">Privacy Policy</a> to generate drafts and Guardian
          verdicts. We don&rsquo;t claim ownership of Your Content and don&rsquo;t use it to train models for
          other customers.
        </p>
        <p>
          You&rsquo;re responsible for having the right to submit any client or third-party data you enter
          into ScopeGov, including names, emails, and correspondence forwarded to Guardian.
        </p>

        <h2 id="guardian-ai">5. Guardian &amp; AI features</h2>
        <p>
          Guardian and our SOW drafting tools use AI models to flag likely out-of-scope requests and generate
          draft language. They are decision support, not a substitute for your own judgment or legal review —
          a Guardian flag is a suggestion, not a determination, and nothing is sent to a client or turned into
          a binding change order without a person on your team approving it first. We don&rsquo;t guarantee
          Guardian will catch every instance of scope creep, nor that AI-drafted language is legally sufficient
          for your situation; you&rsquo;re responsible for reviewing what you send.
        </p>

        <h2 id="signing">6. Client signing</h2>
        <p>
          Our client-signing portal (sign.scopegov.app) lets your clients review and electronically sign
          documents you send. You&rsquo;re responsible for ensuring electronic signature is an appropriate and
          legally valid method for your specific agreements and jurisdiction; we provide the mechanism, not
          legal certification of its sufficiency for your use case.
        </p>

        <h2 id="plans-billing">7. Plans &amp; billing</h2>
        <p>
          Current plans and pricing are shown at checkout and on our <a href="/#pricing">pricing page</a>.
          Subscriptions renew automatically and are billed in advance through Paystack. New trials do not
          require a card up front; if you add a payment method during trial, we&rsquo;ll only start billing
          when the trial ends or you upgrade, whichever you&rsquo;ve chosen. You can cancel at any time from
          your workspace settings — cancellation takes effect at the end of the current billing period, and
          we don&rsquo;t provide partial-period refunds except where required by law.
        </p>

        <h2 id="acceptable-use">8. Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>Use ScopeGov to send fraudulent, deceptive, or intentionally inaccurate scope or billing documents to clients.</li>
          <li>Attempt to bypass workspace permissions, rate limits, or the audit trail.</li>
          <li>Reverse-engineer, scrape, or resell access to the service without our written consent.</li>
          <li>Upload content you don&rsquo;t have the right to share, or that infringes a third party&rsquo;s rights.</li>
          <li>Use the service in a way that violates applicable law, including data-protection or e-signature law in your jurisdiction.</li>
        </ul>

        <h2 id="termination">9. Suspension &amp; termination</h2>
        <p>
          We may suspend or terminate access for material breach of these Terms, non-payment after notice, or
          conduct that puts the security or integrity of the service at risk. You may cancel at any time. On
          termination, we retain your content for the period described in our{' '}
          <a href="/legal/privacy">Privacy Policy</a> to allow export, then delete it on our standard schedule.
        </p>

        <h2 id="warranty">10. Disclaimer of warranty</h2>
        <p>
          ScopeGov is provided &ldquo;as is.&rdquo; To the extent permitted by law, we disclaim implied
          warranties of merchantability, fitness for a particular purpose, and non-infringement. We don&rsquo;t
          warrant that Guardian will detect all scope deviations, that AI-generated drafts require no review,
          or that the service will be uninterrupted or error-free.
        </p>

        <h2 id="liability">11. Limitation of liability</h2>
        <p>
          To the extent permitted by law, neither party is liable for indirect, incidental, consequential, or
          punitive damages arising from these Terms or the service. Our total liability for any claim is
          capped at the amount you paid us in the{' '}
          <span className={styles.placeholder}>[12 months]</span> preceding the claim. Nothing here limits
          liability where the law doesn&rsquo;t allow it to be limited (for example, gross negligence, where
          applicable under Kenyan law).
        </p>

        <h2 id="indemnity">12. Indemnity</h2>
        <p>
          You&rsquo;ll indemnify us against claims arising from Your Content, your use of the service in
          violation of these Terms, or your violation of a third party&rsquo;s rights (including a client&rsquo;s
          data-protection rights in content you submit about them).
        </p>

        <h2 id="governing-law">13. Governing law</h2>
        <p>
          These Terms are governed by the laws of{' '}
          <span className={styles.placeholder}>[Kenya, or chosen jurisdiction]</span>, without regard to
          conflict-of-law principles. <span className={styles.placeholder}>[Add dispute-resolution / venue clause here]</span>.
        </p>

        <h2 id="changes">14. Changes to these terms</h2>
        <p>
          We may update these Terms from time to time. For material changes, we&rsquo;ll notify workspace
          owners by email or in-app notice before they take effect. Continued use after that date means you
          accept the updated Terms.
        </p>

        <h2 id="contact">15. Contact</h2>
        <p>Questions about these Terms: <a href="mailto:legal@scopegov.app">legal@scopegov.app</a>.</p>
      </div>
    </article>
  )
}
