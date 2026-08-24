import styles from '@/styles/legal.module.css'

export const metadata = {
  title: 'Privacy Policy',
  description: 'How ScopeGov collects, uses, and protects your data.',
}

export default function PrivacyPolicyPage() {
  return (
    <article>
      <span className={styles.docBadge}>Legal &middot; Privacy</span>
      <h1 className={styles.title}>Privacy Policy</h1>
      <p className={styles.meta}>Last updated: <span className={styles.placeholder}>[DATE OF PUBLICATION]</span> &middot; Effective on publication</p>

      <div className={styles.reviewNote}>
        <strong>Draft for internal review.</strong> This is a first pass, written to match how ScopeGov&rsquo;s
        codebase actually handles data (see subprocessors below) — it is not legal advice and hasn&rsquo;t been
        reviewed by counsel. Fields in <span className={styles.placeholder}>amber</span> need real values
        before this goes live, and the retention, jurisdiction, and cookie sections in particular should get
        a lawyer&rsquo;s eyes given you&rsquo;re handling client contract and payment data across borders.
      </div>

      <nav className={styles.toc}>
        <div className={styles.tocTitle}>On this page</div>
        <ul className={styles.tocList}>
          <li><a href="#who-we-are">1. Who we are</a></li>
          <li><a href="#what-we-collect">2. What we collect</a></li>
          <li><a href="#how-we-use-it">3. How we use it</a></li>
          <li><a href="#ai-processing">4. AI processing</a></li>
          <li><a href="#subprocessors">5. Subprocessors</a></li>
          <li><a href="#legal-basis">6. Legal basis</a></li>
          <li><a href="#retention">7. Retention &amp; deletion</a></li>
          <li><a href="#your-rights">8. Your rights</a></li>
          <li><a href="#security">9. Security</a></li>
          <li><a href="#international">10. International transfers</a></li>
          <li><a href="#children">11. Children</a></li>
          <li><a href="#changes">12. Changes to this policy</a></li>
          <li><a href="#contact">13. Contact</a></li>
        </ul>
      </nav>

      <div className={styles.prose}>
        <h2 id="who-we-are">1. Who we are</h2>
        <p>
          ScopeGov (&ldquo;ScopeGov,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) is a scope-governance platform for
          agencies: it drafts Statements of Work, monitors client communication against them, and manages the
          change orders and invoicing that follow. This policy explains what we collect through
          scopegov.app and sign.scopegov.app (our client-signing portal), and what we do with it.
        </p>
        <p>
          ScopeGov is operated by Saltern Studio Ltd., a company registered in{' '}
          <span className={styles.placeholder}>[Kenya / registration number]</span>, with a registered
          address at <span className={styles.placeholder}>[registered address]</span>. See our{' '}
          <a href="/legal/terms">Terms of Service</a> for the full contracting relationship.
        </p>

        <h2 id="what-we-collect">2. What we collect</h2>
        <p>We collect different data depending on who you are to us:</p>
        <ul>
          <li><strong>Agency accounts.</strong> Name, work email, password (hashed via Supabase Auth), workspace and role, and optionally a TOTP factor if you enable two-factor authentication.</li>
          <li><strong>Content you create.</strong> Statements of Work, change orders, invoices, client and project records, and any briefs, drafts, or comments you enter into the product.</li>
          <li><strong>Client &amp; signer data.</strong> Names, emails, and signatures of the people your agency invites to review or sign a document through the portal — provided by you, not collected directly from them beyond what&rsquo;s needed to complete a signature.</li>
          <li><strong>Forwarded correspondence.</strong> If you forward client emails to a project&rsquo;s Guardian inbox (via Postmark), we process the message content to check it against that project&rsquo;s signed scope.</li>
          <li><strong>Billing data.</strong> Handled by Paystack; we store the resulting subscription status and plan tier, not full card numbers.</li>
          <li><strong>Usage &amp; device data.</strong> IP address, browser/device information, and in-app activity, used for security (e.g. session integrity, audit logging) rather than marketing analytics.</li>
        </ul>

        <h2 id="how-we-use-it">3. How we use it</h2>
        <ul>
          <li>To provide the product — generating SOWs, running Guardian checks, routing approvals, rendering invoices and PDFs.</li>
          <li>To secure accounts — session management, MFA enforcement on governance-level permissions, and the audit trail of who did what.</li>
          <li>To operate the business — billing, customer support, and service emails (trial reminders, overdue-payment notices, invite and approval notifications).</li>
          <li>To maintain the service — error monitoring, background jobs (e.g. nightly reconciliation and portfolio rollups), and abuse prevention.</li>
        </ul>
        <p>We do not sell personal data, and we do not use your workspace&rsquo;s content to train models for other customers.</p>

        <h2 id="ai-processing">4. AI processing</h2>
        <p>
          Two parts of ScopeGov send data to third-party AI providers to function:
        </p>
        <ul>
          <li><strong>SOW drafting and Guardian classification</strong> send the relevant brief, SOW text, or forwarded message content to Anthropic&rsquo;s Claude API to generate a draft or a scope-match verdict.</li>
          <li><strong>Semantic search over your SOW history</strong> uses OpenAI&rsquo;s embeddings API to convert document text into vector representations stored in our own database.</li>
        </ul>
        <p>
          Both are processed under those providers&rsquo; standard API terms, which — as of this policy&rsquo;s
          drafting — do not use API-submitted content to train their models. We send only what&rsquo;s needed
          for the specific request (e.g. one project&rsquo;s SOW and the message being checked), not your full
          workspace, and results are scoped back to the workspace that generated them.
        </p>

        <h2 id="subprocessors">5. Subprocessors</h2>
        <p>We use the following subprocessors to run ScopeGov. We&rsquo;ll update this table when that list changes.</p>
        <table className={styles.table}>
          <thead>
            <tr><th>Provider</th><th>Purpose</th><th>Data involved</th></tr>
          </thead>
          <tbody>
            <tr><td>Supabase</td><td>Database, authentication, file storage</td><td>All workspace data; account credentials</td></tr>
            <tr><td>Vercel</td><td>Application hosting &amp; background jobs</td><td>Request/session data in transit</td></tr>
            <tr><td>Anthropic</td><td>SOW drafting, Guardian classification</td><td>SOW text, forwarded message content</td></tr>
            <tr><td>OpenAI</td><td>Document embeddings for search</td><td>SOW and document text</td></tr>
            <tr><td>Resend</td><td>Transactional email delivery</td><td>Recipient email, notification content</td></tr>
            <tr><td>Postmark</td><td>Inbound email parsing (Guardian)</td><td>Forwarded message content and headers</td></tr>
            <tr><td>Paystack</td><td>Subscription billing</td><td>Billing contact details; payment handled by Paystack directly</td></tr>
          </tbody>
        </table>

        <h2 id="legal-basis">6. Legal basis</h2>
        <p>
          Where GDPR or a similar framework applies, we process agency account and content data under
          <strong> contract</strong> (to provide the service you signed up for) and client/signer data under
          <strong> legitimate interest</strong> — completing the specific document your agency sent them —
          or, where required, consent collected at the point of signing. We process billing data under
          <strong> legal obligation</strong> (tax and accounting records).
        </p>

        <h2 id="retention">7. Retention &amp; deletion</h2>
        <p>
          We keep workspace content for as long as your account is active, plus a limited grace period after
          cancellation so you can export or reactivate. As implemented today: cancelled-workspace data is
          purged on a scheduled basis, and completed projects are retained for a period before automatic
          purge unless your plan&rsquo;s document-history settings say otherwise. If you&rsquo;d like an
          exact number of days for each of these, add it here: <span className={styles.placeholder}>[retention periods]</span>.
          You can request earlier deletion at any time — see <a href="#contact">Contact</a>.
        </p>

        <h2 id="your-rights">8. Your rights</h2>
        <p>Depending on where you&rsquo;re located, you may have the right to access, correct, export, or delete your personal data, and to object to or restrict certain processing. To exercise any of these, email <a href="mailto:privacy@scopegov.app">privacy@scopegov.app</a>. If you&rsquo;re a client or signer whose data was submitted by an agency using ScopeGov, we&rsquo;ll generally direct your request to that agency first, since they control the underlying relationship — but reach out and we&rsquo;ll help route it.</p>

        <h2 id="security">9. Security</h2>
        <p>
          Data is stored in Postgres with row-level security enforced per workspace, so one agency&rsquo;s data
          is never queryable by another&rsquo;s session. Sensitive workspace secrets are isolated in a
          separate, deny-all table reachable only by trusted server processes. We support and, for
          governance-level permissions, enforce two-factor authentication. No system is perfectly secure —
          see our <a href="/legal/security">Security page</a> for more detail and how to report a concern.
        </p>

        <h2 id="international">10. International transfers</h2>
        <p>
          ScopeGov and its subprocessors operate infrastructure in multiple regions. Where personal data
          moves across borders — for example to a subprocessor headquartered outside your country — we rely
          on that provider&rsquo;s standard contractual clauses or equivalent safeguards. Specifics:{' '}
          <span className={styles.placeholder}>[hosting region(s), SCC details]</span>.
        </p>

        <h2 id="children">11. Children</h2>
        <p>ScopeGov is a business tool. It isn&rsquo;t directed at, and we don&rsquo;t knowingly collect data from, anyone under 18.</p>

        <h2 id="changes">12. Changes to this policy</h2>
        <p>We&rsquo;ll post material changes here with an updated date, and where required, notify workspace owners directly.</p>

        <h2 id="contact">13. Contact</h2>
        <p>Questions about this policy or your data: <a href="mailto:privacy@scopegov.app">privacy@scopegov.app</a>.</p>
      </div>
    </article>
  )
}
