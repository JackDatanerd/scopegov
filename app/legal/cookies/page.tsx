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
      <p className={styles.meta}>Last updated: October 2026</p>


      <div className={styles.prose}>
        <h2>What we use cookies for</h2>
        <p>
          ScopeGov uses a small number of cookies, mainly to keep you signed in and keep the product working
          correctly, plus one to attribute referral sign-ups. We don&rsquo;t use them for advertising or to
          track you across other sites.
        </p>

        <div className={styles.tableWrap} role="region" aria-label="Cookies we set" tabIndex={0}>
        <table className={styles.table}>
          <thead><tr><th>Cookie</th><th>Purpose</th><th>Duration</th><th>Type</th></tr></thead>
          <tbody>
            <tr><td>Supabase session cookies</td><td>Keep you signed in and identify your active workspace session</td><td>Up to 400 days; removed when you sign out</td><td>Strictly necessary</td></tr>
            <tr><td>Sign-in verification cookie (name ends in <code>-code-verifier</code>)</td><td>Lets a sign-in or password-reset link finish correctly, including when it returns on a different <code>scopegov.app</code> address than the one you started on</td><td>Removed as soon as sign-in completes (an abandoned sign-in can leave it in your browser for up to 400 days)</td><td>Strictly necessary</td></tr>
            <tr><td><code>ss_ref</code></td><td>Remembers which referral link brought a first-time visitor to the site, so we can attribute signups correctly</td><td>30 days</td><td>Functional (first-party; no cross-site tracking)</td></tr>
          </tbody>
        </table>
        </div>

        <h2>What we don&rsquo;t use</h2>
        <p>
          As built, ScopeGov does not set third-party advertising cookies, and does not use a
          cross-site analytics tracker. If we add product analytics in the future that relies on
          non-essential cookies, we&rsquo;ll update this page and ask for consent where required before
          setting them.
        </p>

        <h2>Browser storage and third-party scripts</h2>
        <p>
          While you set up a workspace, the onboarding wizard saves your progress in your browser&rsquo;s local
          storage so you can resume it; that data stays in your browser. Separately, when you open billing
          checkout, Paystack&rsquo;s checkout script loads from js.paystack.co, and Paystack may set its own
          cookies under its own policy.
        </p>

        <h2>Managing cookies</h2>
        <p>
          Our sign-in cookies are strictly necessary for signing in and basic site function, so there
          isn&rsquo;t an in-product toggle to disable them — blocking them in your browser will generally
          prevent you from staying signed in. The referral cookie (<code>ss_ref</code>) isn&rsquo;t needed to
          use ScopeGov; blocking or clearing it doesn&rsquo;t affect signing in. You can clear or block cookies
          through your browser&rsquo;s settings at any time.
        </p>

        <h2>Questions</h2>
        <p>Email <a href="mailto:privacy@scopegov.app">privacy@scopegov.app</a>.</p>
      </div>
    </article>
  )
}
