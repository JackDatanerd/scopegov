import styles from '@/styles/legal.module.css'

export const metadata = {
  title: 'Data Processing Addendum',
  description: 'Terms governing ScopeGov\'s processing of personal data on behalf of customers.',
}

export default function DpaPage() {
  return (
    <article>
      <span className={styles.docBadge}>Legal &middot; DPA</span>
      <h1 className={styles.title}>Data Processing Addendum</h1>
      <p className={styles.meta}>Last updated: <span className={styles.placeholder}>[DATE OF PUBLICATION]</span> &middot; Effective on publication</p>

      <div className={styles.reviewNote}>
        <strong>Draft for internal review.</strong> This follows the standard controller/processor shape
        (roughly GDPR Art. 28-style) that most agency customers with EU or UK clients will expect to see. It
        is not legal advice, and the audit-rights, breach-notification-window, and SCC-annex sections need a
        lawyer&rsquo;s pass — particularly if you plan to sign this bilaterally with enterprise customers
        rather than publishing it as a standard addendum.
      </div>

      <nav className={styles.toc}>
        <div className={styles.tocTitle}>On this page</div>
        <ul className={styles.tocList}>
          <li><a href="#parties">1. Parties &amp; scope</a></li>
          <li><a href="#roles">2. Roles</a></li>
          <li><a href="#processing-details">3. Details of processing</a></li>
          <li><a href="#customer-instructions">4. Processing on instructions</a></li>
          <li><a href="#confidentiality">5. Confidentiality</a></li>
          <li><a href="#security-measures">6. Security measures</a></li>
          <li><a href="#subprocessors">7. Subprocessors</a></li>
          <li><a href="#data-subject-requests">8. Data subject requests</a></li>
          <li><a href="#breach">9. Breach notification</a></li>
          <li><a href="#deletion">10. Return &amp; deletion</a></li>
          <li><a href="#audit">11. Audit rights</a></li>
          <li><a href="#transfers">12. International transfers</a></li>
          <li><a href="#precedence">13. Precedence</a></li>
        </ul>
      </nav>

      <div className={styles.prose}>
        <h2 id="parties">1. Parties &amp; scope</h2>
        <p>
          This Data Processing Addendum (&ldquo;DPA&rdquo;) forms part of the Terms of Service between the
          customer (&ldquo;Controller,&rdquo; &ldquo;you&rdquo;) and Saltern Studio Ltd., operating as ScopeGov
          (&ldquo;Processor,&rdquo; &ldquo;we&rdquo;). It applies whenever we process personal data on your
          behalf as part of the service — most commonly, data about your clients and their signers that you
          enter into ScopeGov.
        </p>

        <h2 id="roles">2. Roles</h2>
        <p>
          You act as Controller for the personal data of your own team, your clients, and their
          representatives that you submit to ScopeGov. We act as Processor with respect to that data, and as
          independent Controller only for the limited account and billing data described in our{' '}
          <a href="/legal/privacy">Privacy Policy</a> that we need to run our own business relationship with
          you.
        </p>

        <h2 id="processing-details">3. Details of processing</h2>
        <table className={styles.table}>
          <thead><tr><th>Category</th><th>Detail</th></tr></thead>
          <tbody>
            <tr><td>Subject matter</td><td>Provision of the ScopeGov scope-governance platform</td></tr>
            <tr><td>Duration</td><td>Term of the underlying Terms of Service, plus retention period on termination</td></tr>
            <tr><td>Nature of processing</td><td>Storage, retrieval, AI-assisted drafting and classification, transmission (e.g. email, signing portal), deletion</td></tr>
            <tr><td>Categories of data</td><td>Names, emails, and correspondence of client contacts and signers; SOW, change order, and invoice content; agency team account data</td></tr>
            <tr><td>Categories of data subjects</td><td>Your team members; your clients&rsquo; contacts and authorized signers</td></tr>
          </tbody>
        </table>

        <h2 id="customer-instructions">4. Processing on instructions</h2>
        <p>
          We process personal data only on your documented instructions — which include the instructions
          built into your configuration of the service (for example, forwarding a thread to Guardian, or
          inviting a named signer) — unless required to do otherwise by law, in which case we&rsquo;ll notify
          you first where legally permitted.
        </p>

        <h2 id="confidentiality">5. Confidentiality</h2>
        <p>We ensure that anyone we authorize to process personal data is under an obligation of confidentiality, whether contractual or statutory.</p>

        <h2 id="security-measures">6. Security measures</h2>
        <p>
          We maintain technical and organizational measures appropriate to the risk, including row-level
          database access control per workspace, isolation of sensitive workspace secrets from
          general application access, encryption in transit, and two-factor authentication enforced for
          governance-level permissions. Full detail is on our <a href="/legal/security">Security page</a>.
        </p>

        <h2 id="subprocessors">7. Subprocessors</h2>
        <p>
          You authorize the subprocessors listed in our <a href="/legal/privacy#subprocessors">Privacy
          Policy</a>. We&rsquo;ll give notice before adding a new subprocessor that will handle personal data
          in scope of this DPA, so you can object on reasonable data-protection grounds. Notice method:{' '}
          <span className={styles.placeholder}>[email list / changelog page]</span>.
        </p>

        <h2 id="data-subject-requests">8. Data subject requests</h2>
        <p>
          If we receive a request from one of your clients or their signers to exercise a data-subject right,
          we&rsquo;ll forward it to you promptly rather than responding directly, since you control the
          underlying relationship. We&rsquo;ll give you reasonable assistance to respond, including through
          the export and deletion tools built into the product.
        </p>

        <h2 id="breach">9. Breach notification</h2>
        <p>
          We&rsquo;ll notify you without undue delay, and in any case within{' '}
          <span className={styles.placeholder}>[72 hours]</span> of becoming aware, of any confirmed breach
          affecting personal data we process on your behalf, with the information reasonably available to us
          at that time.
        </p>

        <h2 id="deletion">10. Return &amp; deletion</h2>
        <p>
          On termination, you can export your workspace&rsquo;s content before it&rsquo;s deleted on the
          schedule described in our <a href="/legal/privacy#retention">Privacy Policy</a>, unless we&rsquo;re
          required to retain a copy by law.
        </p>

        <h2 id="audit">11. Audit rights</h2>
        <p>
          On reasonable written notice, and no more than once per 12 months absent a specific security
          concern, we&rsquo;ll provide the information reasonably necessary to demonstrate compliance with
          this DPA — <span className={styles.placeholder}>[specify: questionnaire response, summary
          report, or on-site/remote audit terms]</span>.
        </p>

        <h2 id="transfers">12. International transfers</h2>
        <p>
          Where personal data is transferred outside your jurisdiction to a subprocessor listed above, we
          rely on that provider&rsquo;s Standard Contractual Clauses or an equivalent recognized transfer
          mechanism. <span className={styles.placeholder}>[Attach SCC annex / transfer impact assessment reference if required]</span>.
        </p>

        <h2 id="precedence">13. Precedence</h2>
        <p>This DPA forms part of, and is incorporated into, our <a href="/legal/terms">Terms of Service</a>. In the event of a conflict specific to data protection, this DPA controls.</p>
      </div>
    </article>
  )
}
