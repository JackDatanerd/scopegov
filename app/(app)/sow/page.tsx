// app/(app)/sow/page.tsx

import { MEMBER_PROJECT_EMBED_SUFFIX, scopeToMemberProjects } from '@/lib/utils/member-project-scope'
import { getSessionStrict, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatDate, formatCurrency, sowStatusLabel } from '@/lib/utils/format' // C6: removed sowStatusColour

export const metadata = { title: 'SOW Registry' }

export default async function SowPage() {
  const session = await getSessionStrict()
  if (!session) redirect('/login')

  const service = createServiceClient()

  const isSoloCapped = session.planTier === 'solo'
  const limit        = isSoloCapped ? 10 : 500

  // FIX (section-9 audit): this page had no project-membership filtering
  // at all — every SOW in the workspace (client name, contract value,
  // status) was returned to any authenticated member, including one
  // deliberately restricted to VIEW_OWN_PROJECTS with no VIEW_ALL_PROJECTS.
  // Every other document list in the app (api/sow/[id], api/projects,
  // api/invoices) already gates on project membership — this registry
  // page was the one place that didn't. /invoices/page.tsx copied this
  // same gap; fixed there too.
  // FIX (section-9 re-audit): the "Value" column rendered
  // s.projects.contract_value unconditionally — every other place
  // contract value appears (GET /api/sow/[id], the projects list, the
  // dashboard, clients, reports, invoices) gates it behind
  // VIEW_FINANCIALS. This registry page was the one place that didn't:
  // a member explicitly denied financial visibility (e.g. the preset
  // Designer role) could still read every SOW's contract value straight
  // off this table. Same fix shape as ProjectsClient.tsx: hide the whole
  // column, not just the value, so its absence isn't itself a "there's a
  // number here you can't see" tell.
  const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')
  const canViewAll = hasPermission(session, 'VIEW_ALL_PROJECTS')
  // FIX (Search section, round 8 — traced from /api/search): the registry used to read the member's whole
  // project list and send every id back in `.in('project_id', ids)`. Those rows are never removed when a
  // project completes, so past a couple of hundred projects the URL exceeded gateway limits and the page showed an
  // empty registry for exactly the long-tenured members. The restriction is now an embedded filter through the
  // relationship (lib/utils/member-project-scope.ts), active memberships only — the same rule as the
  // project_members_active view (migration 070) this read used.
  const restricted = !canViewAll
  const memberEmbed = restricted ? MEMBER_PROJECT_EMBED_SUFFIX : ''

  let sowQuery = (service as any)
    .from('sow_documents')
    .select(`id, version, document_number, status, sent_at, signed_at, created_at,
      projects!inner(id, name, contract_value, currency, type, deleted_at, clients(name)${memberEmbed})`)
    .eq('workspace_id', session.workspaceId)
    // FIX (SOW lifecycle independent pass, S2): SOWs of soft-deleted projects were listed and
    // counted (and linked to a project page that 404s). Same filter the invoices registry uses.
    .is('projects.deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (restricted) sowQuery = scopeToMemberProjects(sowQuery, session.id, 'projects.project_members')

  const { data: sows = [], error: sowErr } = await sowQuery

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
  // Also scoped to the member's projects now, same reasoning as the list above.
  // FIX (section-9 audit, build-blocking): `session` is typed
  // `SessionUser | null` and TypeScript can't carry the early
  // `if (!session) redirect(...)` narrowing into this closure, so this
  // failed `tsc --noEmit`. Capture the narrowed value.
  const workspaceId = session.workspaceId
  const workspaceUserId = session.id
  function countQuery(status?: string) {
    let q = (service as any).from('sow_documents').select(`id, projects!inner(deleted_at${memberEmbed})`, { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).is('projects.deleted_at', null)
    if (restricted) q = scopeToMemberProjects(q, workspaceUserId, 'projects.project_members')
    if (status) q = q.eq('status', status)
    return q
  }
  const [{ count: totalCount, error: totalErr }, { count: signedCount, error: signedErr }, { count: pendingCount, error: pendingErr }] = await Promise.all([
    countQuery(),
    countQuery('signed'),
    countQuery('awaiting_signature'),
  ])

  // FIX (SOW lifecycle independent pass 16, B1): neither the list nor the counts had their failure surfaced — a failed
  // query rendered "No SOWs yet" and zero / list-capped totals as if they were true. Same fix the invoices registry got.
  const loadFailed = !!sowErr || !!totalErr || !!signedErr || !!pendingErr
  if (totalErr || signedErr || pendingErr) console.error('SOW registry count error:', totalErr || signedErr || pendingErr)

  const stats = {
    total:   totalCount   ?? safeSows.length,
    signed:  signedCount  ?? safeSows.filter((s: any) => s.status === 'signed').length,
    pending: pendingCount ?? safeSows.filter((s: any) => s.status === 'awaiting_signature').length,
  }

  // FIX (section-9 re-audit, independent pass): the solo-tier banner below
  // was the ONLY place this page ever told the user the table was
  // truncated — but `stats.total` (an exact, uncapped count) and `safeSows`
  // (capped at `limit`) can diverge for ANY workspace, not just solo ones,
  // once a paid-tier workspace's SOW history exceeds 500 rows. Without this
  // page having any pagination or filtering, that workspace would see e.g.
  // "Total SOWs: 612" above a table silently showing only the newest 500,
  // with the oldest 112 simply missing and nothing on screen to say so.
  const isTruncated = !isSoloCapped && stats.total > safeSows.length

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-title">SOW Registry</h1>
          <p className="page-sub">All Statements of Work across your workspace</p>
        </div>
      </div>

      {loadFailed && (
        <div className="banner banner-danger" style={{ marginBottom: 20 }}>
          <span>The SOW registry could not be fully loaded, so what you see below may be incomplete. Reload the page to try again.</span>
        </div>
      )}

      {/* FIX (SOW lifecycle pass, B6): only when older SOWs are actually hidden. */}
      {isSoloCapped && stats.total > safeSows.length && (
        <div className="banner banner-info" style={{ marginBottom: 20 }}>
          <span>Showing the 10 most recent SOWs. <strong>Upgrade to Starter or above</strong> to see the full history.</span>
          <Link href="/settings?tab=billing">
            <button className="btn btn-primary btn-sm">Upgrade</button>
          </Link>
        </div>
      )}

      {isTruncated && (
        <div className="banner banner-info" style={{ marginBottom: 20 }}>
          <span>Showing the {limit} most recent of {stats.total} SOWs. Older SOWs aren&rsquo;t listed on this page.</span>
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

      {sowErr && !safeSows.length ? null : !safeSows.length ? (
        <div className="surface">
          <div className="empty-state">
            <i className="ti ti-file-description empty-state-icon" />
            <p className="empty-state-title">No SOWs yet</p>
            <p className="empty-state-sub">SOWs are generated when you create a project and complete the scope brief.</p>
            {/* Gated like every other entry point to the wizard: POST /api/projects requires CREATE_PROJECTS. */}
            {hasPermission(session, 'CREATE_PROJECTS') && (
              <Link href="/projects/new">
                <button className="btn btn-primary"><i className="ti ti-plus" style={{ fontSize: 13 }} /> New project</button>
              </Link>
            )}
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
                {canViewFinancials && <th>Value</th>}
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
                  {canViewFinancials && (
                    <td className="td-mono" style={{ textAlign: 'right', fontSize: 12 }}>
                      {/* FIX (SOW lifecycle re-audit — fresh independent pass): this was a
                          truthy check (`? :`), the same $0-vs-null display bug already found
                          and fixed on three separate Portfolio surfaces. contract_value can
                          legitimately be 0 (parseContractValue allows it, and checkSowLock only
                          blocks lowering it while a SOW is signed/awaiting_signature/pending-
                          approval — not once terminal, i.e. withdrawn/declined/expired), so a
                          $0 project showed a blank "—" instead of "$0" to a viewer who can see
                          financials. Null-check instead, so only a genuinely missing value (no
                          project, or a null contract_value) falls back to the dash. */}
                      {s.projects?.contract_value != null
                        ? formatCurrency(s.projects.contract_value, s.projects.currency) + (s.projects.type === 'retainer' ? '/mo' : '')
                        : '—'}
                    </td>
                  )}
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
