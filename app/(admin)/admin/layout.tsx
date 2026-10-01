import { redirect } from 'next/navigation'
import { getAdminActor, adminNeedsMfaEnrolment } from '@/lib/auth/admin'
import styles from '@/styles/admin.module.css'
import AdminNav from './AdminNav'

// Not found rather than a login/permission redirect for the same reason
// requireAdmin() in the API layer returns 404: a non-admin (including one
// who guesses the URL) learns nothing about whether this surface exists.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await getAdminActor()
  if (!actor) {
    // A confirmed platform admin who simply hasn't enrolled a factor yet is sent to set
    // one up (it works without any workspace — see app/mfa-setup/page.tsx). Anyone else
    // gets the same silent redirect as before, so the surface's existence stays hidden.
    if (await adminNeedsMfaEnrolment()) redirect('/mfa-setup?next=%2Fadmin')
    redirect('/dashboard')
  }

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
