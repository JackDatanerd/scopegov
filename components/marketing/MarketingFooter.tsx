import Link from 'next/link'
import styles from '@/styles/marketing.module.css'
import { BrandMark } from './BrandMark'

export default function MarketingFooter() {
  return (
    <footer className={styles.footer} id="faq">
      <div className={styles.wrap}>
        <div className={styles.footerTop}>
          <div>
            <Link href="/" className={styles.brand}>
              <BrandMark className={styles.brandMark} />
              ScopeGov
            </Link>
            <p className={styles.footerBrandDesc}>Scope governance for agencies. Governance over scope. Authority over revenue.</p>
          </div>
          <div className={styles.footerCol}>
            <div className={styles.footerColTitle}>Product</div>
            <a href="#product">SOW generation</a>
            <a href="#guardian">Guardian</a>
            <a href="#pricing">Pricing</a>
            <a href="#portfolio">Portfolio</a>
          </div>
          <div className={styles.footerCol}>
            <div className={styles.footerColTitle}>Company</div>
            <Link href="/legal/security">Security</Link>
            <a href="mailto:hello@scopegov.app">Contact</a>
            <a href="mailto:support@scopegov.app">Support</a>
          </div>
          <div className={styles.footerCol}>
            <div className={styles.footerColTitle}>Legal</div>
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/terms">Terms</Link>
            <Link href="/legal/dpa">DPA</Link>
            <Link href="/legal/cookies">Cookies</Link>
          </div>
        </div>
        <div className={styles.footerBottom}>
          <span>© {new Date().getFullYear()} ScopeGov. All rights reserved.</span>
          <div className={styles.footerLegalLinks}>
            <Link href="/legal/privacy">Privacy</Link>
            <Link href="/legal/terms">Terms</Link>
            <Link href="/legal/dpa">DPA</Link>
          </div>
        </div>
      </div>
    </footer>
  )
}
