import styles from '@/styles/legal.module.css'

export const metadata = {
  title: 'Cookie Policy',
  description: 'What cookies ScopeGov sets and why.',
}

export default function CookiesPage() {
  return (
    <article>
      <span className={styles.docBadge}>Legal &middot; Cookies</span>
      <h1 className={styles.title}>Cookie Policy</h1>
      <p className={styles.meta}>Last updated: <span className={styles.placeholder}>[DATE OF PUBLICATION]</span></p>

      <div className={styles.reviewNote}>
        <strong>Draft for internal review.</strong> This reflects the cookies actually set by the codebase
        today — session cookies from Supabase Auth and a first-touch referral cookie in middleware. There is
        no analytics or advertising cookie in the app as built. If that changes (adding product analytics,
        for instance), this page and the consent banner it implies will both need updating.
      </div>

      <div className={styles.prose}>
        <h2>What we use cookies for</h2>
        <p>
          ScopeGov uses a small number of cookies to keep you signed in and to keep the product working
          correctly — not for advertising, and not to track you across other sites.
        </p>

        <table className={styles.table}>
          <thead><tr><th>Cookie</th><th>Purpose</th><th>Duration</th><th>Type</th></tr></thead>
          <tbody>
            <tr><td>Supabase session cookies</td><td>Keep you signed in and identify your active workspace session</td><td>Session / refresh-token lifetime</td><td>Strictly necessary</td></tr>
            <tr><td><code>ss_ref</code></td><td>Remembers which referral link brought a first-time visitor to the site, so we can attribute signups correctly</td><td>30 days</td><td>Strictly necessary (first-party, no cross-site tracking)</td></tr>
          </tbody>
        </table>

        <h2>What we don&rsquo;t use</h2>
        <p>
          As built, ScopeGov does not set third-party advertising cookies, and does not use a
          cross-site analytics tracker. If we add product analytics in the future that relies on
          non-essential cookies, we&rsquo;ll update this page and ask for consent where required before
          setting them.
        </p>

        <h2>Managing cookies</h2>
        <p>
          Because our current cookies are strictly necessary for signing in and basic site function, there
          isn&rsquo;t an in-product toggle to disable them — blocking them in your browser will generally
          prevent you from staying signed in. You can clear or block cookies through your browser&rsquo;s
          settings at any time.
        </p>

        <h2>Questions</h2>
        <p>Email <a href="mailto:privacy@scopegov.app">privacy@scopegov.app</a>.</p>
      </div>
    </article>
  )
}
