// app/(app)/sow/page.tsx

import { getSession } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatDate, formatCurrency, sowStatusLabel } from '@/lib/utils/format' // C6: removed sowStatusColour

export const metadata = { title: 'SOW Registry' }

export default async function SowPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  const service = createServiceClient()

  const isSoloCapped = session.planTier === 'solo'
  const limit        = isSoloCapped ? 10 : 500

  const { data: sows = [], error: sowErr } = await (service as any)
    .from('sow_documents')
    .select(`id, version, document_number, status, sent_at, signed_at, created_at,
      projects(id, name, contract_value, currency, clients(name))`)
    .eq('workspace_id', session.workspaceId)
    .order('created_at', { ascending: false })
    .limit(limit)

  // C6: render empty state rather than crash if query fails
  if (sowErr) {
    console.error('SOW registry error:', sowErr)
  }

  const safeSows = sows || []

  // FIX (re-audit): these stats used to be computed from `safeSows`, which
  // is capped by `limit` (10 for solo tier, 500 otherwise). "Total SOWs"
  // was really "count of the first `limit` fetched" — silently wrong for
  // any workspace that ever exceeds that cap, with no disclaimer outside
  // the solo-tier banner. Use exact counts, unaffected by the row limit.
  const [{ count: totalCount }, { count: signedCount }, { count: pendingCount }] = await Promise.all([
    (service as any).from('sow_documents').select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId),
    (service as any).from('sow_documents').select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId).eq('status', 'signed'),
    (service as any).from('sow_documents').select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId).eq('status', 'awaiting_signature'),
  ])

  const stats = {
    total:   totalCount   ?? safeSows.length,
    signed:  signedCount  ?? safeSows.filter((s: any) => s.status === 'signed').length,
    pending: pendingCount ?? safeSows.filter((s: any) => s.status === 'awaiting_signature').length,
  }

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">SOW Registry</h1>
          <p className="page-sub">All Statements of Work across your workspace</p>
        </div>
      </div>

      {isSoloCapped && (
        <div className="banner banner-info" style={{ marginBottom: 20 }}>
          <span>Showing the 10 most recent SOWs. <strong>Upgrade to Starter or above</strong> to see the full history.</span>
          <Link href="/settings?tab=billing">
            <button className="btn btn-primary btn-sm">Upgrade</button>
          </Link>
        </div>
      )}

      <div className="mstrip mstrip-3" style={{ marginBottom: 22 }}>
        <div className="mc">
          <div className="mc-lbl">Total SOWs</div>
          <div className="mc-val">{stats.total}</div>
          <div className="mc-sub">All versions</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Signed</div>
          <div className="mc-val green">{stats.signed}</div>
          <div className="mc-sub">Active agreements</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Awaiting signature</div>
          <div className="mc-val gold">{stats.pending}</div>
          <div className="mc-sub">Pending client action</div>
        </div>
      </div>

      {!safeSows.length ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-file-description empty-state-icon" />
            <p className="empty-state-title">No SOWs yet</p>
            <p className="empty-state-sub">SOWs are generated when you create a project and complete the scope brief.</p>
            <Link href="/projects/new">
              <button className="btn btn-primary"><i className="ti ti-plus" style={{ fontSize: 13 }} /> New project</button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="surface" style={{ overflow: 'hidden' }}>
          <table className="gov-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>No.</th>
                <th>Project</th>
                <th>Client</th>
                <th>Version</th>
                <th>Status</th>
                <th>Sent</th>
                <th>Signed</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {safeSows.map((s: any) => (
                <tr key={s.id}>
                  <td className="td-mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{s.document_number || '—'}</td>
                  <td>
                    <Link href={`/projects/${s.projects?.id}?tab=sow`}>
                      <div className="td-primary">{s.projects?.name || '—'}</div>
                    </Link>
                  </td>
                  <td style={{ color: 'var(--text-2)', fontSize: 13 }}>{s.projects?.clients?.name || '—'}</td>
                  <td className="td-mono" style={{ fontSize: 12 }}>v{s.version}</td>
                  <td>
                    <span className={`pill pill-${pillVariant(s.status)}`}>
                      {sowStatusLabel(s.status)}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{s.sent_at ? formatDate(s.sent_at) : '—'}</td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{s.signed_at ? formatDate(s.signed_at) : '—'}</td>
                  <td className="td-mono" style={{ textAlign: 'right', fontSize: 12 }}>
                    {s.projects?.contract_value
                      ? formatCurrency(s.projects.contract_value, s.projects.currency)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function pillVariant(status: string): string {
  const m: Record<string, string> = {
    draft:              'slate',
    awaiting_signature: 'amber',
    signed:             'green',
    declined:           'red',
    changes_requested:  'amber',
    withdrawn:          'slate',
    expired:            'red',
  }
  return m[status] || 'slate'
}
