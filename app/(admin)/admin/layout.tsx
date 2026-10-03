import { requireAdminPage } from '@/lib/admin/page-guard'
import styles from '@/styles/admin.module.css'
import AdminNav from './AdminNav'
import StepUpHost from '@/components/auth/StepUpHost'

// Not found rather than a login/permission redirect for the same reason
// requireAdmin() in the API layer returns 404: a non-admin (including one
// who guesses the URL) learns nothing about whether this surface exists.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // The page-guard also runs inside every data page: a layout redirect alone does not protect them
  // (see lib/admin/page-guard.ts).
  const actor = await requireAdminPage()

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
      {/* FIX (Auth+MFA pass 8 — MEDIUM): the mutating admin routes require a step-up, and this
          is the modal that answers it (fetchWithStepUp in the detail pages). Without it a
          lapsed 10-minute window left admins at "confirm it's you" with no way to. */}
      <StepUpHost />
      <main className={styles.main}>{children}</main>
    </div>
  )
}
