'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import styles from '@/styles/admin.module.css'

const LINKS = [
  { href: '/admin', label: 'Overview', exact: true },
  { href: '/admin/workspaces', label: 'Workspaces' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/billing', label: 'Billing' },
  { href: '/admin/finance', label: 'Finance' },
  { href: '/admin/system', label: 'System health' },
  { href: '/admin/audit', label: 'Admin audit log' },
]

export default function AdminNav() {
  const pathname = usePathname()
  return (
    <nav className={styles.nav}>
      {LINKS.map(link => {
        const active = link.exact ? pathname === link.href : pathname.startsWith(link.href)
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`${styles.navLink} ${active ? styles.navLinkActive : ''}`}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
