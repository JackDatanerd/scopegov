import Link from 'next/link'
import styles from '@/styles/legal.module.css'
import { BrandMark } from '@/components/marketing/BrandMark'

export default function LegalShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link href="/" className={styles.brand}>
            <BrandMark className={styles.brandMark} />
            ScopeGov
          </Link>
          <Link href="/" className={styles.backLink}>&larr; Back to home</Link>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.wrap}>{children}</div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          {/* Legal-entity disclosure lives here, and only here — not on the
              marketing site — since this is the one place it's actually
              required (contracting party identification). */}
          <span>ScopeGov is operated by Saltern Studio Ltd., Nairobi, Kenya.</span>
          <div className={styles.footerLinks}>
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/terms">Terms</Link>
            <Link href="/legal/dpa">DPA</Link>
            <Link href="/legal/security">Security</Link>
            <Link href="/legal/cookies">Cookies</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
