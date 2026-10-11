import Link from 'next/link'
import styles from '@/styles/marketing.module.css'
import HomeMark from './HomeMark'
import NavMenu from './NavMenu'

export default function MarketingHeader() {
  return (
    <header className={styles.nav}>
      <div className={styles.wrap}>
        <a className={styles.logo} href="#top" aria-label="ScopeGov home">
          <HomeMark className={styles.logoMark} />
          ScopeGov
        </a>
        <NavMenu>
          <Link className={styles.signin} href="/login">Sign in</Link>
          <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/signup">Start free trial</Link>
        </NavMenu>
      </div>
    </header>
  )
}
