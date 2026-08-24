import Link from 'next/link'
import styles from '@/styles/marketing.module.css'
import { BrandMark } from './BrandMark'

export default function MarketingHeader() {
  return (
    <header className={styles.header}>
      <nav className={styles.nav}>
        <Link href="/" className={styles.brand}>
          <BrandMark className={styles.brandMark} />
          ScopeGov
        </Link>
        <div className={styles.navLinks}>
          <a href="#product">Product</a>
          <a href="#guardian">Guardian</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
        </div>
        <div className={styles.navCta}>
          <Link href="/login" className={styles.navSignin}>Sign in</Link>
          <Link href="/signup" className={`${styles.btn} ${styles.btnPrimary}`}>Start free trial</Link>
        </div>
      </nav>
    </header>
  )
}
