import Link from 'next/link'
import styles from '@/styles/legal.module.css'
import { BrandMark } from '@/components/marketing/BrandMark'

// Public wrapper for /calculator. Reuses the legal pages' header/footer chrome so the page looks like part of the
// marketing site, without the contracting-entity line that only belongs on the legal pages.
export default function CalculatorShell({ children }: { children: React.ReactNode }) {
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
        <div className={styles.wrap} style={{ maxWidth: 1080 }}>{children}</div>
      </main>
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>Estimates only, based on the numbers you enter.</span>
          <div className={styles.footerLinks}>
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/terms">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
