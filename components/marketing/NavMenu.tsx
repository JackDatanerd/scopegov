'use client'
import { useEffect, useRef, useState } from 'react'
import styles from '@/styles/marketing.module.css'

type Item = { href: string; label: string; hint: string }
type Group = { id: string; label: string; items: Item[] }

// Every in-page section is reachable from here. Keep in sync with the section ids in MarketingHome.tsx
// (tests/homepage-rebrand.test.ts asserts every href below resolves to an id on the page).
export const NAV_GROUPS: Group[] = [
  {
    id: 'product',
    label: 'Product',
    items: [
      { href: '#how', label: 'How it works', hint: 'From brief to bank transfer' },
      { href: '#guardian', label: 'Guardian', hint: 'Reads every email against the signed SOW' },
      { href: '#features', label: 'Features', hint: 'SOWs, change orders, signing, roles, billing' },
      { href: '#portfolio', label: 'Portfolio', hint: 'Scope risk across every project' },
    ],
  },
  {
    id: 'evidence',
    label: 'Evidence',
    items: [
      { href: '#proof', label: 'The numbers', hint: 'What the platform has processed' },
      { href: '#before-after', label: 'Before and after', hint: 'Same project, different Friday' },
      { href: '#creep', label: 'Scope creep, ranked', hint: 'The requests that cost the most' },
      { href: '#stories', label: 'Stories', hint: 'What agencies say' },
    ],
  },
]
export const NAV_LINKS: Item[] = [
  { href: '#pricing', label: 'Pricing', hint: '' },
  { href: '#faq', label: 'FAQ', hint: '' },
]

export default function NavMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<string | null>(null)
  const [mobile, setMobile] = useState(false)
  const navRef = useRef<HTMLElement | null>(null)
  // True while the open menu was opened by hover (or a touch's synthetic hover): the click that follows must keep it open, not toggle it shut.
  const byHover = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(null)
        setMobile(false)
      }
    }
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpen(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [])

  const close = () => {
    setOpen(null)
    setMobile(false)
  }

  return (
    <>
      <nav className={styles.navLinks} aria-label="Primary" ref={navRef}>
        {NAV_GROUPS.map((g) => (
          <div
            key={g.id}
            className={`${styles.navItem} ${open === g.id ? styles.open : ''}`.trim()}
            onMouseEnter={() => {
              byHover.current = true
              setOpen(g.id)
            }}
            onMouseLeave={() => setOpen(null)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen((o) => (o === g.id ? null : o))
            }}
          >
            <button
              type="button"
              className={styles.navBtn}
              aria-expanded={open === g.id}
              aria-controls={`menu-${g.id}`}
              onClick={() => {
                const keepOpen = byHover.current
                byHover.current = false
                setOpen((o) => (o === g.id && !keepOpen ? null : g.id))
              }}
            >
              {g.label}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="m2 3.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <div id={`menu-${g.id}`} className={styles.menu} hidden={open !== g.id}>
              {g.items.map((it) => (
                <a key={it.href} href={it.href} onClick={close}>
                  <b>{it.label}</b>
                  <span>{it.hint}</span>
                </a>
              ))}
            </div>
          </div>
        ))}
        {NAV_LINKS.map((l) => (
          <a key={l.href} href={l.href} className={styles.navPlain}>{l.label}</a>
        ))}
      </nav>

      <div className={styles.navCta}>
        {children}
        <button
          type="button"
          className={styles.burger}
          aria-expanded={mobile}
          aria-controls="mobile-menu"
          aria-label={mobile ? 'Close menu' : 'Open menu'}
          onClick={() => setMobile((m) => !m)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            {mobile ? <path d="m5 5 10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /> : <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
          </svg>
        </button>
      </div>

      <div id="mobile-menu" className={styles.mobileMenu} hidden={!mobile}>
        {NAV_GROUPS.map((g) => (
          <div key={g.id}>
            <div className={styles.mmTitle}>{g.label}</div>
            {g.items.map((it) => (
              <a key={it.href} href={it.href} onClick={close}>{it.label}</a>
            ))}
          </div>
        ))}
        <div>
          <div className={styles.mmTitle}>More</div>
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} onClick={close}>{l.label}</a>
          ))}
          <a href="/login" onClick={close}>Sign in</a>
        </div>
      </div>
    </>
  )
}
