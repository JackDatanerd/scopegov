import { redirect } from 'next/navigation'
import { getAdminActor } from '@/lib/auth/admin'
import styles from '@/styles/admin.module.css'
import AdminNav from './AdminNav'

// Not found rather than a login/permission redirect for the same reason
// requireAdmin() in the API layer returns 404: a non-admin (including one
// who guesses the URL) learns nothing about whether this surface exists.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await getAdminActor()
  if (!actor) redirect('/dashboard')

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          ScopeGov
          <span className={styles.brandSub}>Platform Admin</span>
        </div>
        <AdminNav />
        <div className={styles.footer}>
          Signed in as<br />
          <strong style={{ color: '#D6D9DE' }}>{actor.name}</strong>
          <br />
          <a href="/dashboard" className={styles.footerLink}>&larr; Back to app</a>
        </div>
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  )
}
