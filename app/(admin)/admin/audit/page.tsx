import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { requireAdminPage } from '@/lib/admin/page-guard'
import { ADMIN_EVENT_TYPES, fmtUtc, summarizeAdminMetadata } from '@/lib/admin/format'
import { escapeIlike } from '@/lib/audit/search'
import styles from '@/styles/admin.module.css'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type SP = { page?: string; event?: string; admin?: string; target?: string; q?: string; reads?: string }

export default async function AdminAuditLogPage({ searchParams }: { searchParams: SP }) {
  await requireAdminPage()
  const service = createServiceClient() as any

  const page = Math.max(1, parseInt(searchParams?.page || '1', 10) || 1)
  // Filters are allow-listed / validated: `event` must be a known type, `target` a uuid, free text is ILIKE-escaped.
  const event = (ADMIN_EVENT_TYPES as readonly string[]).includes(searchParams?.event || '') ? searchParams.event! : ''
  const target = UUID_RE.test(searchParams?.target || '') ? searchParams.target! : ''
  const admin = (searchParams?.admin || '').trim().slice(0, 100)
  const q = (searchParams?.q || '').trim().slice(0, 100)
  const showReads = searchParams?.reads === '1'

  const from = (page - 1) * PAGE_SIZE
  let query = service
    .from('platform_admin_audit_log')
    .select('id, admin_name, admin_email, event_type, target_type, target_label, target_id, metadata, ip_address, created_at', { count: 'exact' })
    .order('created_at', { ascending: false }).order('id', { ascending: false })
  if (event) query = query.eq('event_type', event)
  else if (!showReads) query = query.not('event_type', 'like', '%.viewed').not('event_type', 'like', '%.searched')
  if (target) query = query.eq('target_id', target)
  if (admin) query = query.ilike('admin_email', `%${escapeIlike(admin)}%`)
  if (q) query = query.ilike('target_label', `%${escapeIlike(q)}%`)

  const { data: rows, count, error } = await query.range(from, from + PAGE_SIZE - 1)

  const qs = (over: Record<string, string | number>) => {
    const p = new URLSearchParams()
    const all: Record<string, string> = { event, admin, target, q, reads: showReads ? '1' : '', page: String(page), ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) }
    for (const [k, v] of Object.entries(all)) if (v && !(k === 'page' && v === '1')) p.set(k, v)
    const str = p.toString()
    return `/admin/audit${str ? `?${str}` : ''}`
  }

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE))
  // A page past the end (a stale link, a filter that shrank the result) used to render "No admin actions recorded yet".
  if (!error && page > totalPages) redirect(qs({ page: totalPages }))

  const filtered = !!(event || target || admin || q)

  return (
    <div>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Admin audit log</div>
          <div className={styles.subtitle}>Every action taken from this panel — separate from each workspace&rsquo;s own activity feed. Times are UTC.</div>
        </div>
      </div>

      <form method="get" action="/admin/audit" className={styles.searchRow}>
        <select name="event" defaultValue={event} className={styles.select}>
          <option value="">All actions</option>
          {ADMIN_EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input name="admin" defaultValue={admin} className={styles.input} placeholder="Admin e-mail…" />
        <input name="q" defaultValue={q} className={styles.input} placeholder="Target name / e-mail…" />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <input type="checkbox" name="reads" value="1" defaultChecked={showReads} /> Include views &amp; searches
        </label>
        {target && <input type="hidden" name="target" value={target} />}
        <button className="btn btn-ghost btn-sm" type="submit">Filter</button>
        {filtered && <Link className="btn btn-ghost btn-sm" href="/admin/audit">Clear</Link>}
      </form>

      {error && (
        <div className={`${styles.notice} ${styles.noticeBad}`}>
          Could not load the admin audit log ({error.message}). This is a read failure — it does not mean nothing was recorded.
        </div>
      )}

      <div className={styles.card}>
        {error ? null : (rows || []).length === 0 ? (
          <div className={styles.empty}>{filtered ? 'No admin actions match these filters.' : 'No admin actions recorded yet.'}</div>
        ) : (
          <table className={styles.table}>
            <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr></thead>
            <tbody>
              {rows.map((r: any) => {
                const summary = summarizeAdminMetadata(r.event_type, r.metadata)
                const hasMeta = r.metadata && Object.keys(r.metadata).length > 0
                return (
                  <tr key={r.id}>
                    <td className={styles.mono}>{fmtUtc(r.created_at)}</td>
                    <td>{r.admin_name}<div className={`${styles.mono} ${styles.muted}`}>{r.admin_email}</div></td>
                    <td className={styles.mono}>{r.event_type}</td>
                    <td>
                      <span className={`${styles.badge} ${styles.badgeGray}`}>{r.target_type}</span>{' '}
                      {r.target_label || <span className={styles.muted}>—</span>}
                      {r.target_id && (
                        <div><Link className={`${styles.mono} ${styles.muted}`} href={qs({ target: r.target_id, page: 1 })}>history</Link></div>
                      )}
                    </td>
                    <td>
                      {hasMeta ? (
                        <details className={styles.details}>
                          <summary>{summary || 'details'}</summary>
                          <pre>{JSON.stringify(r.metadata, null, 2)}</pre>
                        </details>
                      ) : <span className={styles.muted}>—</span>}
                    </td>
                    <td className={styles.mono}>{r.ip_address || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <div className={styles.pager}>
          {/* aria-disabled does nothing on an <a> — the link was still followable. */}
          {page <= 1
            ? <span className={`btn btn-ghost btn-sm ${styles.pagerDisabled}`}>Previous</span>
            : <Link className="btn btn-ghost btn-sm" href={qs({ page: page - 1 })}>Previous</Link>}
          <span>Page {Math.min(page, totalPages)} of {totalPages} · {count ?? 0} total</span>
          {page >= totalPages
            ? <span className={`btn btn-ghost btn-sm ${styles.pagerDisabled}`}>Next</span>
            : <Link className="btn btn-ghost btn-sm" href={qs({ page: page + 1 })}>Next</Link>}
        </div>
      </div>
    </div>
  )
}
