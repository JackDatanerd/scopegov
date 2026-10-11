import Link from 'next/link'
import styles from '@/styles/marketing.module.css'
import HomeMark from './HomeMark'

// Layout is the previous homepage footer (brand + Product / Company / Legal columns + legal bar). The Product column's
// anchors point at sections that exist on the current page (the old #product / #portfolio sections are gone), and the
// footer no longer carries id="faq" — the FAQ is now its own section.
export default function MarketingFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.wrap}>
        <div className={styles.footerTop}>
          <div>
            <a href="#top" className={styles.logo}>
              <HomeMark className={styles.logoMark} />
              ScopeGov
            </a>
            <p className={styles.footerBrandDesc}>Scope governance for agencies. Governance over scope. Authority over revenue.</p>
          </div>
          <div className={styles.footerCol}>
            <div className={styles.footerColTitle}>Product</div>
            <a href="#how">How it works</a>
            <a href="#guardian">Guardian</a>
            <a href="#features">Features</a>
            <a href="#portfolio">Portfolio</a>
            <a href="#pricing">Pricing</a>
            <Link href="/calculator">Scope-loss calculator</Link>
            <a href="#faq">FAQ</a>
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
