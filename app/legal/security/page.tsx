import styles from '@/styles/legal.module.css'

export const metadata = {
  title: 'Security',
  description: 'How ScopeGov protects workspace and client data.',
}

export default function SecurityPage() {
  return (
    <article>
      <span className={styles.docBadge}>Trust &middot; Security</span>
      <h1 className={styles.title}>Security</h1>
      <p className={styles.meta}>Last updated: October 2026</p>


      <div className={styles.prose}>
        <h2>Data isolation</h2>
        <p>
          Row-level security is enabled on ScopeGov&rsquo;s database tables, scoped to workspace membership,
          so a direct database session belonging to one agency&rsquo;s workspace cannot read or write
          another workspace&rsquo;s data. Server-side operations that run with elevated credentials bypass
          row-level security by design, so for those we also enforce workspace membership and permissions in
          application code on every request.
        </p>

        <h2>Secret isolation</h2>
        <p>
          Sensitive workspace secrets (such as signing keys) are stored in a dedicated table with a deny-all
          row-level security policy, reachable only by trusted server-side processes using elevated
          credentials — never by direct client queries, and never exposed as a column on a table that
          ordinary workspace members can already read.
        </p>

        <h2>Authentication &amp; access</h2>
        <ul>
          <li>Passwords are hashed and managed by Supabase Auth; we never see or store them in plain text.</li>
          <li>Two-factor authentication (TOTP) is available to every account and is required for permissions we classify as governance-sensitive, such as approving documents, managing billing, roles and workspace settings, viewing the audit log, the portfolio, or all projects, and deleting projects.</li>
          <li>Sessions are held in Secure, SameSite=Lax cookies. Actions tied to governance-level permissions require a session that has completed the second factor.</li>
        </ul>

        <h2>Audit trail</h2>
        <p>
          Governance-relevant actions — sending a SOW, approving or rejecting a change order, granting a
          scope exception, changing a team member&rsquo;s role — are recorded in an append-only audit log,
          attributed to the acting user and timestamped, so workspace owners can reconstruct who decided what.
        </p>

        <h2>Data in transit &amp; at rest</h2>
        <p>
          All traffic to ScopeGov is encrypted in transit (TLS). Data at rest is encrypted using our
          infrastructure provider&rsquo;s standard encryption-at-rest for managed Postgres and object storage.
        </p>

        <h2>Subprocessor handling</h2>
        <p>
          Where we send data to a subprocessor to power a feature — for example, sending a SOW to Anthropic&rsquo;s
          API to check scope, or an email to Resend to deliver a notification — we send only what that
          specific request needs, not a workspace&rsquo;s full data set. See the subprocessor table in our{' '}
          <a href="/legal/privacy#subprocessors">Privacy Policy</a>.
        </p>

        <h2>Reporting a concern</h2>
        <p>
          If you believe you&rsquo;ve found a security issue in ScopeGov, please email{' '}
          <a href="mailto:security@scopegov.app">security@scopegov.app</a> with details and, if possible,
          steps to reproduce. We&rsquo;ll acknowledge reports and keep you updated as we investigate. Please
          give us a reasonable window to fix an issue before disclosing it publicly.
        </p>
      </div>
    </article>
  )
}
