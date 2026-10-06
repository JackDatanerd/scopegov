import { getSessionStrict, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatCurrency, formatCurrencyGroups, formatRelative, projectStatusLabel, PLAN_LABELS, PLAN_LIMITS } from '@/lib/utils/format'
import { isAttentionWorthy, attentionReason } from '@/lib/utils/attention'
import { IN_PROGRESS_STATUSES } from '@/lib/utils/project-status'
import { effectiveContractValue, monthlyRetainerRate, loadRetainerMonthsBilled } from '@/lib/utils/contract-value'
import { shapeActivityRow, DASHBOARD_NOISE_EVENT_PATTERNS } from '@/lib/utils/activity-format'
import { fetchPaged, fetchPagedIn, queryInChunks } from '@/lib/utils/paginate'
import { loadMemberProjectIds } from '@/lib/utils/member-project-ids'
import type { SessionUser } from '@/lib/supabase/types'

export const metadata = { title: 'Dashboard' }

// FIX (Projects & Dashboard independent pass): see the matching constant and
// comment in app/api/projects/route.ts — a plain, unbounded select against
// `projects` silently truncates at PostgREST's 1000-row cap, and this page's
// own comment elsewhere already assumed (incorrectly) that the Projects list
// "fetches every project in the workspace uncapped" safely; neither page
// actually guarded against the cap until now.
const DASHBOARD_PROJECTS_MAX_ROWS = 20000

// Rows read before the live-project filter trims the feed to 14. Rows of soft-deleted projects are dropped after the
// read, so a window of only 60 could leave the feed nearly empty after a burst of deletions.
const ACTIVITY_OVERFETCH = 200

// Projects & Dashboard deep audit: this used new Date().getHours() on the
// SERVER (UTC on Vercel), so the greeting was wrong for almost everyone
// ("Good morning" at 1pm in Nairobi, "Good afternoon" at 8am in California).
// It now uses the workspace's own timezone.
function greeting(timeZone?: string | null) {
  let h: number
  try {
    h = parseInt(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: timeZone || undefined }).format(new Date()), 10)
    if (Number.isNaN(h)) h = new Date().getUTCHours()
  } catch {
    h = new Date().getUTCHours() // invalid stored timezone name
  }
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

function pillVariant(status: string): string {
  const map: Record<string, string> = {
    'Active': 'green', 'Awaiting Signature': 'amber', 'Changes Requested': 'amber',
    'Stalled': 'red', 'Complete': 'slate', 'Draft': 'slate', 'Intake': 'blue', 'Archived': 'slate',
  }
  return map[status] || 'slate'
}

const TONE_COLOUR: Record<string, string> = {
  green: 'var(--green)', red: 'var(--red)', amber: 'var(--amber)', blue: 'var(--blue)',
}

export default async function DashboardPage() {
  const session = await getSessionStrict()
  if (!session) redirect('/login')

  const service         = createServiceClient()
  const canViewAll      = hasPermission(session, 'VIEW_ALL_PROJECTS')
  const canCreate       = hasPermission(session, 'CREATE_PROJECTS')
  const canViewFinances = hasPermission(session, 'VIEW_FINANCIALS')

  const daysLeft = session.planTier === 'trial' && session.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(session.trialEndsAt).getTime() - Date.now()) / 86400000))
    : null

  // FIX (deep audit, section 7): this select fed the same isAttentionWorthy
  // / attentionReason predicate as app/(app)/projects/page.tsx, but with a
  // narrower shape — sow_documents(status) had no `version`, so the
  // "highest version actually sent to the client" sort those functions do
  // degenerated to an arbitrary pick (all comparisons return 0). Bring the
  // select in line with the Projects list's so the two pages agree.
  //
  // FIX (deep audit, section 7 — pagination follow-up): this also carried
  // a .limit(80), ordered by updated_at. That's fine for the *rendered*
  // preview (active.slice(0,8), attention.slice(0,6), both already
  // truncated below with "All projects →" links to the uncapped /projects
  // list) — but it's not just a preview cap. isAttentionWorthy() below
  // only ever runs against whatever this query returns, so in a workspace
  // with more than 80 projects, an attention-worthy project that simply
  // hasn't been touched recently (an open flag sitting untouched, a
  // stalled SOW no one's revisited) could silently fall out of the top 80
  // and never appear in the Attention register at all — no error, no
  // count mismatch, it just disappears. /projects already fetches every
  // project in the workspace uncapped with this same join shape, so
  // there's no new cost model here — compute against the full set, keep
  // the .slice() calls below for what's actually rendered.
  // FIX (deep audit, section 7): this omitted `currency`, so
  // isAttentionWorthy's currency-mismatch guard on the proactive-risk-alert
  // rule (workspace?.currency undefined → currencyMatches always true)
  // was silently defeated here — the exact guard it's meant to enforce was
  // correctly applied on the Projects list (which does fetch currency) and
  // not on the Dashboard, for the same project.
  // FIX (Projects & Dashboard pass 10, B1): `error` was never read. A failed read leaves `ws` null, so the proactive-risk rule silently runs on its
  // defaults even for a workspace that switched it off, and the currency-mismatch guard is dropped. The dashboard still renders (it must not
  // break on a settings read), but the failure is logged like the other degraded reads here.
  const { data: ws, error: wsErr } = await (service as any)
    .from('workspaces').select('proactive_risk_alerts_enabled,proactive_risk_threshold,currency,timezone')
    .eq('id', session.workspaceId).maybeSingle()
  if (wsErr) console.error('Dashboard: workspace settings read failed — attention rules are using defaults:', wsErr.message)

  let accessibleProjectIds: string[] | null = null
  if (!canViewAll) {
    // FIX: project_members has neither workspace_id nor user_id columns —
    // see app/api/projects/route.ts for the full explanation. This
    // silently returned nothing for anyone without VIEW_ALL_PROJECTS.
    // Paged (a plain select is silently capped at 1000 rows) — see lib/utils/member-project-ids.ts.
    accessibleProjectIds = await loadMemberProjectIds(service, session.id)
    if (!accessibleProjectIds?.length) return <EmptyDash session={session} canCreate={canCreate} daysLeft={daysLeft} greetingText={greeting(ws?.timezone)} />
  }

  // FIX (Projects & Dashboard independent pass): fetchPaged so a workspace
  // whose project count exceeds PostgREST's silent 1000-row cap can't lose
  // projects off the Dashboard with no error and no signal — see the
  // matching fix (and full reasoning) in GET /api/projects.
  const dashboardProjectQuery = (from: number, to: number) => (service as any)
    .from('projects')
    .select(`id,name,disc,type,status,stall_reason,stalled_at,contract_value,retainer_duration_months,currency,updated_at,
      clients(id,name),guardian_flags(status),change_orders(id,status,parent_co_id,sent_at),sow_documents(id,status,version),
      amendments(financial_impact,change_orders(is_retainer_renewal))`, { count: 'exact' })
    .eq('workspace_id', session.workspaceId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to)
  // Restricted members: id list is chunked (B4) so a long project history can't blow the request URL.
  const projPage = accessibleProjectIds === null
    ? await fetchPaged<any>((from, to) => dashboardProjectQuery(from, to), { maxRows: DASHBOARD_PROJECTS_MAX_ROWS })
    : await fetchPagedIn<any>(accessibleProjectIds, (chunk, from, to) => dashboardProjectQuery(from, to).in('id', chunk),
        { maxRows: DASHBOARD_PROJECTS_MAX_ROWS },
        (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.id).localeCompare(String(a.id)))
  if (projPage.truncated)
    throw new Error(`Dashboard project list truncated: workspace exceeded ${DASHBOARD_PROJECTS_MAX_ROWS} projects`)
  const projectRows = projPage.rows
  // "Contract value" everywhere on this page is the shared effective value (base — a retainer's monthly
  // rate × term — plus accepted change orders). It used to be the stored base alone, so approving a CO
  // never moved the tile, and a retainer counted one month's fee as its whole value.
  const retainerMonths = await loadRetainerMonthsBilled(service, projectRows || [])
  const projects = (projectRows || []).map((p: any) => {
    const { amendments, ...rest } = p
    return { ...rest, effective_value: effectiveContractValue(p, amendments, retainerMonths.get(p.id)), monthly_rate: monthlyRetainerRate(p) }
  })
  const projectNameById = new Map<string, string>(projects.map((p: any) => [p.id, p.name]))

  // FIX (audit round 4, finding #8): this was workspace-wide with no
  // project-membership filtering at all — a VIEW_OWN_PROJECTS-restricted
  // member's dashboard showed audit_log rows (including entity names and
  // financial metadata like CO/invoice amounts) for every project in the
  // workspace, not just their own. audit_log has no project_id column and
  // entity_id is polymorphic (project id for project.* events, but a
  // sub-entity id like sow_id/co_id/invoice_id for most others), so it
  // can't be reliably scoped by project for arbitrary event types without
  // a per-entity-type join. Rather than ship a partially-correct filter,
  // restricted users get a narrower but fully-correct feed: only
  // project-lifecycle events (entity_type = 'project', where entity_id is
  // guaranteed to be the project id itself) for projects they can access.
  // A `project_id` column on audit_log, populated at write time, would
  // let this show the full picture safely — worth a follow-up migration.
  // Activity feed. Projects & Dashboard deep audit — two bugs fixed here:
  //  1. It showed the WHOLE workspace audit log (security.login_succeeded,
  //     billing.plan_changed, role.updated ...) to anyone with
  //     VIEW_ALL_PROJECTS, bypassing VIEW_AUDIT_LOG and burying project events
  //     under login noise. It is now project-scoped: only rows tied to a
  //     project (audit_log.project_id, migration 056).
  //  2. Restricted (VIEW_OWN_PROJECTS) members only ever saw project.* rows,
  //     because SOW/CO/flag/invoice events carry their own entity ids. With
  //     project_id every project event is reachable for the projects they
  //     can access.
  // The window is only 14 rows, so machinery events (every Guardian classification, every "client opened
  // the link", every automated reminder) are filtered out in SQL — they used to fill the whole feed.
  // A factory, not a shared builder: PostgREST builders are mutable, so each chunked read needs a fresh one.
  const buildActivityQuery = () => {
  let activityQuery = (service as any)
    .from('audit_log').select('id,event_type,entity_type,entity_name,actor_name,created_at,metadata,project_id')
    .eq('workspace_id', session.workspaceId)
    .not('project_id', 'is', null)
  for (const pattern of DASHBOARD_NOISE_EVENT_PATTERNS) activityQuery = activityQuery.not('event_type', 'like', pattern)
  // Over-fetch, then keep only rows whose project is still live: audit rows of soft-deleted projects (and, for
  // restricted members, project_members rows pointing at deleted projects) otherwise render as name-less entries
  // linking to a page that 404s. The project's own Activity route already hides them.
  activityQuery = activityQuery.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(ACTIVITY_OVERFETCH)
  return activityQuery
  }

  let activityRaw: any[] = []
  if (!canViewAll) {
    // Chunked (B4): each chunk returns its newest ACTIVITY_OVERFETCH; merge and keep the newest ACTIVITY_OVERFETCH overall.
    const res = await queryInChunks<any>(accessibleProjectIds || [], chunk => buildActivityQuery().in('project_id', chunk))
    // FIX (Projects & Dashboard pass 10, B1): a failed read rendered "No recent activity" with nothing in the logs. Still degrades; now logged.
    if (res.error) console.error('Dashboard: activity feed read failed — the feed is empty or partial:', res.error.message)
    activityRaw = res.data
      .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)))
      .slice(0, ACTIVITY_OVERFETCH)
  } else {
    const res = await buildActivityQuery()
    if (res.error) console.error('Dashboard: activity feed read failed — the feed is empty:', res.error.message)
    activityRaw = res.data || []
  }
  const activity = (activityRaw || []).filter((a: any) => projectNameById.has(a.project_id)).slice(0, 14).map((a: any) =>
    shapeActivityRow(a, { viewFinancials: canViewFinances, projectName: projectNameById.get(a.project_id) ?? null }))

  // FIX (section-11/12 audit — flagship feature gap): see lib/utils/attention.ts
  // — isAttentionWorthy() had no clause for a document stuck in an approval
  // chain at all. Fetched as its own query (rather than an embedded
  // approval_requests(...) on the projects select above) to keep the
  // pending-only filter simple and unambiguous — an embedded-resource
  // filter here would need care not to inner-join projects with zero
  // pending requests out of the result entirely.
  // FIX (fix round, section-11 flagship finding): this only ever matched
  // status='pending' — a request that already cleared approval but failed
  // to auto-send afterward (status='approved', send_failed_at set — see
  // migration 053) is just as stuck, but the underlying document is still
  // 'draft' (the send never completed), so nothing else on this page ever
  // surfaced it either. Broadened to match both states, and send_failed_at
  // is carried through so isAttentionWorthy/attentionReason (see
  // lib/utils/attention.ts) can treat it as immediately attention-worthy
  // rather than waiting out the ordinary pending-decision stall window.
  const buildPendingApprovalsQuery = () => (service as any)
    .from('approval_requests')
    .select('project_id, created_at, updated_at, step_started_at, send_failed_at')
    .eq('workspace_id', session.workspaceId)
    .or('status.eq.pending,and(status.eq.approved,send_failed_at.not.is.null)')
  // FIX (approvals independent pass, B1): neither branch looked at `error`, so a failed read quietly became "no request is
  // pending" and every "awaiting approval" / "approved but not sent" attention flag vanished with nothing in the logs.
  // The attention list is secondary to the page, so it still degrades rather than break the dashboard — but the failure
  // is now logged.
  let pendingApprovalRows: any[]
  if (!canViewAll) {
    const res = await queryInChunks<any>(accessibleProjectIds || [], chunk => buildPendingApprovalsQuery().in('project_id', chunk))
    if (res.error) console.error('Dashboard: pending approvals read failed — approval attention flags are missing:', res.error.message)
    pendingApprovalRows = res.data
  } else {
    const res = await buildPendingApprovalsQuery()
    if (res.error) console.error('Dashboard: pending approvals read failed — approval attention flags are missing:', res.error.message)
    pendingApprovalRows = res.data || []
  }
  const pendingApprovalsByProject = new Map<string, Array<{ createdAt: string; sendFailed?: boolean }>>()
  for (const r of (pendingApprovalRows || [])) {
    const list = pendingApprovalsByProject.get(r.project_id) || []
    // FIX (section-11 audit, pass 2 + B5): the "stuck" clock is when the CURRENT step became active
    // (step_started_at — set on creation, step advance and reassign), not creation time: a 3-step chain
    // whose step 3 became active an hour ago is not "stuck" just because step 1 was raised two days ago.
    // It is deliberately NOT updated_at: the approval-stall cron bumps updated_at after every reminder
    // (that is its quiet-window marker), which used to reset this clock and hide a still-stuck request
    // for two more days after each nudge. Falls back to updated_at/created_at for rows that predate
    // migration 110's backfill.
    list.push({ createdAt: r.step_started_at || r.updated_at || r.created_at, sendFailed: !!r.send_failed_at })
    pendingApprovalsByProject.set(r.project_id, list)
  }

  // Shared definition (lib/utils/project-status): includes Stalled, which the
  // dashboard used to drop while the Portfolio counted it.
  const active = (projects || []).filter((p: any) =>
    (IN_PROGRESS_STATUSES as readonly string[]).includes(p.status))
  const attention = (projects || []).filter((p: any) =>
    isAttentionWorthy({
      project: { ...p, contractValue: p.effective_value, stallReason: p.stall_reason, stalledAt: p.stalled_at,
        guardianFlags: p.guardian_flags, changeOrders: p.change_orders, sowDocuments: p.sow_documents,
        pendingApprovals: pendingApprovalsByProject.get(p.id) },
      workspace: { proactiveRiskAlertsEnabled: ws?.proactive_risk_alerts_enabled, proactiveRiskThreshold: ws?.proactive_risk_threshold, currency: ws?.currency },
    })
  )
  // FIX (deep audit, section 7): see currencyGroupedTotals in
  // lib/utils/format.ts — this used to sum contract_value across every
  // active project regardless of currency, then label the sum with
  // active[0]'s currency.
  const activeValueDisplay = formatCurrencyGroups(
    active.map((p: any) => ({ contract_value: p.effective_value, currency: p.currency })), true, ws?.currency || 'USD')

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <TrialBanner session={session} daysLeft={daysLeft} />
      <CalculatorNudge session={session} />

      {/* Header */}
      <div className="page-hd">
        <div>
          <h1 className="page-title">{greeting(ws?.timezone)}, {session.name.split(' ')[0]}</h1>
          <p className="page-sub">
            {attention.length > 0
              ? `${attention.length} matter${attention.length !== 1 ? 's' : ''} require${attention.length === 1 ? 's' : ''} attention`
              : 'All records are in order'} · {session.agencyName}
          </p>
        </div>
        {canCreate && (
          <Link href="/projects/new">
            <button className="btn btn-primary">
              <i className="ti ti-plus" style={{ fontSize: 13 }} /> New project
            </button>
          </Link>
        )}
      </div>

      {/* Metrics */}
      <div className="mstrip">
        <div className="mc">
          <div className="mc-lbl">In progress</div>
          <div className="mc-val">{active.length}</div>
          <div className="mc-sub">{(projects || []).length} total on record</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Needs attention</div>
          <div className={`mc-val${attention.length > 0 ? ' red' : ''}`}>{attention.length}</div>
          <div className="mc-sub">{attention.length === 0 ? 'All matters clear' : 'Open matters'}</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Active contract value</div>
          <div className="mc-val green" style={{ fontSize: activeValueDisplay.includes('·') ? 16 : undefined }}>
            {canViewFinances ? activeValueDisplay : '—'}
          </div>
          <div className="mc-sub">Across active projects</div>
        </div>
        <div className="mc">
          <div className="mc-lbl">Subscription</div>
          <div className="mc-val" style={{ fontSize: 20, paddingTop: 3 }}>
            {session.lapsed ? 'No plan' : (PLAN_LABELS[session.planTier] || session.planTier)}
          </div>
          <div className="mc-sub">
            {session.lapsed ? 'Read-only — choose a plan' : daysLeft !== null ? `${daysLeft} days remaining` : 'Active'}
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 24, alignItems: 'start' }}>
        <div>
          {/* Attention register */}
          {attention.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div className="sec-hd">
                <div className="sec-title" style={{ color: 'var(--amber)' }}>
                  <i className="ti ti-alert-circle" style={{ marginRight: 5 }} />
                  Attention register ({attention.length})
                </div>
                <Link href="/projects?filter=attention" style={{ fontSize: 11, color: 'var(--green)' }}>
                  {attention.length > 6 ? `View all ${attention.length} →` : 'All projects →'}
                </Link>
              </div>
              <div className="surface" style={{ overflow: 'hidden' }}>
                <table className="gov-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Open matter</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attention.slice(0, 6).map((p: any) => {
                      const reason = attentionReason({
                        project: { ...p, contractValue: p.effective_value, stallReason: p.stall_reason, stalledAt: p.stalled_at,
                          guardianFlags: p.guardian_flags, changeOrders: p.change_orders, sowDocuments: p.sow_documents,
                          pendingApprovals: pendingApprovalsByProject.get(p.id) }
                      })
                      return (
                        <tr key={p.id}>
                          <td>
                            <Link href={`/projects/${p.id}`}>
                              <div className="td-primary">{p.name}</div>
                              <div className="td-sub">{p.clients?.name}</div>
                            </Link>
                          </td>
                          <td>
                            <span className="attn-marker">
                              <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
                              {reason}
                            </span>
                          </td>
                          <td>
                            <span className={`pill pill-${pillVariant(p.status)}`}>
                              {projectStatusLabel(p.status)}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* In-progress projects */}
          {active.length > 0 && (
            <div>
              <div className="sec-hd">
                <div className="sec-title">In progress</div>
                <Link href="/projects" style={{ fontSize: 11, color: 'var(--green)' }}>All projects →</Link>
              </div>
              <div className="surface" style={{ overflow: 'hidden' }}>
                <table className="gov-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Client</th>
                      {canViewFinances && <th style={{ textAlign: 'right' }}>Contract value</th>}
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.slice(0, 8).map((p: any) => (
                      <tr key={p.id}>
                        <td>
                          <Link href={`/projects/${p.id}`}>
                            <div className="td-primary">{p.name}</div>
                            {p.disc && <div className="td-sub">{p.disc}</div>}
                          </Link>
                        </td>
                        <td style={{ color: 'var(--text-2)', fontSize: 13 }}>{p.clients?.name || '—'}</td>
                        {canViewFinances && (
                          <td className="td-mono" style={{ textAlign: 'right' }}>
                            {p.effective_value ? formatCurrency(p.effective_value, p.currency) : '—'}
                            {p.monthly_rate ? <div className="td-sub">{formatCurrency(p.monthly_rate, p.currency)}/mo</div> : null}
                          </td>
                        )}
                        <td>
                          <span className={`pill pill-${pillVariant(p.status)}`}>
                            {projectStatusLabel(p.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {active.length === 0 && attention.length === 0 && (
            <div className="surface">
              <div className="empty-state">
                <i className="ti ti-scale empty-state-icon" style={{ color: 'var(--green-mid)' }} />
                <p className="empty-state-title">No active projects</p>
                <p className="empty-state-sub">Create your first project to begin governing your scope.</p>
                {canCreate && (
                  <Link href="/projects/new">
                    <button className="btn btn-primary">
                      <i className="ti ti-plus" style={{ fontSize: 13 }} /> New project
                    </button>
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Activity log */}
        <div>
          <div className="sec-hd"><div className="sec-title">Activity log</div></div>
          <div className="surface surface-p" style={{ padding: '12px 16px' }}>
            {!activity.length ? (
              <p style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', padding: '20px 0' }}>No activity yet</p>
            ) : (
              activity.map((a: any) => (
                <div key={a.id} className="feed-item">
                  <div className="feed-dot" style={{ background: TONE_COLOUR[a.tone] || 'var(--blue)', marginTop: 6 }} />
                  <div className="feed-body">
                    <div className="feed-text">{a.actor ? `${a.actor} ` : ''}{a.text}</div>
                    <div className="feed-time">{formatRelative(a.created_at)}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// Trial / expired-trial notice, shared by the dashboard and its empty state.
// FIX (Projects & Dashboard pass 2, B1): the old inline banner only rendered while session.planTier === 'trial', but an
// expired trial is reported as 'solo' the instant it expires — so its "Trial expired" branch could never show, and a
// workspace silently dropped to Solo's project cap with nothing on the dashboard saying why.
function TrialBanner({ session, daysLeft }: { session: SessionUser; daysLeft: number | null }) {
  // A lapsed workspace (expired trial, ended subscription) is read-only; the app-wide banner in (app)/layout.tsx says
  // so on every page, so the dashboard adds nothing of its own.
  if (session.lapsed) return null
  if (session.planTier === 'trial' && daysLeft !== null && daysLeft <= 5) {
    return (
      <div className={`banner ${daysLeft <= 1 ? 'banner-danger' : 'banner-warn'}`}>
        <span>
          <strong>{daysLeft === 0 ? 'Trial ends today.' : `${daysLeft} trial day${daysLeft !== 1 ? 's' : ''} remaining.`}</strong>
          {' '}Upgrade to continue uninterrupted.
        </span>
        <Link href="/settings?tab=billing">
          <button className="btn btn-primary btn-sm">Upgrade now</button>
        </Link>
      </div>
    )
  }
  return null
}

// A running trial: a quiet pointer to the scope-loss calculator for the people who can act on it. Not shown on a
// lapsed workspace (the app-wide banner carries its own link) or to members who cannot choose a plan.
function CalculatorNudge({ session }: { session: SessionUser }) {
  if (session.lapsed || session.planTier !== 'trial' || !session.permissions.includes('MANAGE_BILLING')) return null
  return (
    <p style={{ fontSize: 12.5, color: 'var(--text-2)', margin: '0 0 14px' }}>
      Wondering which plan fits? <Link href="/plan-calculator">See what a plan would recover from your own numbers &rarr;</Link>
    </p>
  )
}

function EmptyDash({ session, canCreate, daysLeft, greetingText }: { session: SessionUser; canCreate: boolean; daysLeft: number | null; greetingText: string }) {
  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <TrialBanner session={session} daysLeft={daysLeft} />
      <CalculatorNudge session={session} />
      <div className="page-hd">
        <div>
          <h1 className="page-title">{greetingText}, {session.name.split(' ')[0]}</h1>
          <p className="page-sub">{session.agencyName} · ScopeGov workspace</p>
        </div>
        {canCreate && (
          <Link href="/projects/new">
            <button className="btn btn-primary">
              <i className="ti ti-plus" style={{ fontSize: 13 }} /> New project
            </button>
          </Link>
        )}
      </div>
      <div className="surface">
        <div className="empty-state" style={{ padding: '80px 32px' }}>
          <i className="ti ti-scale empty-state-icon" style={{ fontSize: 40, color: 'var(--green-mid)' }} />
          <p className="empty-state-title">Your governance record starts here</p>
          <p className="empty-state-sub">
            Create a project, generate a Statement of Work, send it to your client —
            and Guardian monitors every communication for scope drift automatically.
          </p>
          {canCreate && (
            <Link href="/projects/new">
              <button className="btn btn-primary">
                <i className="ti ti-plus" style={{ fontSize: 13 }} /> Create first project
              </button>
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}
