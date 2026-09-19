import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { formatCurrency, formatCurrencyGroups, formatRelative, projectStatusLabel, PLAN_LABELS } from '@/lib/utils/format'
import { isAttentionWorthy, attentionReason } from '@/lib/utils/attention'
import { IN_PROGRESS_STATUSES } from '@/lib/utils/project-status'
import type { SessionUser } from '@/lib/supabase/types'

export const metadata = { title: 'Dashboard' }

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

function feedColour(type: string): string {
  if (type.includes('signed') || type.includes('accepted') || type.includes('completed')) return 'var(--green)'
  if (type.includes('declined') || type.includes('stalled') || type.includes('failed')) return 'var(--red)'
  if (type.includes('flag') || type.includes('guardian')) return 'var(--amber)'
  return 'var(--blue)'
}

function formatEvent(a: any, canViewFinances: boolean): string {
  const n = a.entity_name ? `"${a.entity_name}"` : ''
  const actor = a.actor_name || 'System'
  const map: Record<string, string> = {
    'project.created': `${actor} created project ${n}`,
    'project.status_changed': `${n} status changed to ${a.metadata?.to || ''}`,
    'sow.sent': `SOW sent to client — ${n}`,
    'sow.signed': `Client signed SOW — ${n}`,
    'sow.declined': `Client declined SOW — ${n}`,
    'co.accepted': `Change order accepted — ${n}`,
    'co.declined': `Change order declined — ${n}`,
    'co.countered': `Counter offer received on ${n}`,
    // The renewal amount is a financial figure: only members with
    // VIEW_FINANCIALS see it (it was shown to everyone before).
    'project.retainer_renewed': canViewFinances
      ? `Retainer renewed — ${n} now ${a.metadata?.currency || ''} ${a.metadata?.new_monthly_amount ?? ''}/mo`
      : `Retainer renewed — ${n}`,
    'project.completed': `${n} marked complete`,
    'project.reopened': `${n} reopened`,
    'project.archived': `${n} archived`,
    'co.sent': `Change order sent — ${n}`,
    'flag.raised': `Scope flag raised on ${n}`,
    'flag.resolved': `Scope flag resolved on ${n}`,
    'member.invited': `${actor} invited a team member`,
    'member.joined': `${a.entity_name} joined the workspace`,
  }
  return map[a.event_type] || `${actor} · ${a.event_type.replace(/\./g, ' ')}`
}

export default async function DashboardPage() {
  const session = await getSession()
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
  const { data: ws } = await (service as any)
    .from('workspaces').select('proactive_risk_alerts_enabled,proactive_risk_threshold,currency,timezone')
    .eq('id', session.workspaceId).single()

  let projQuery = (service as any)
    .from('projects')
    .select(`id,name,disc,type,status,stall_reason,contract_value,currency,updated_at,
      clients(id,name),guardian_flags(status),change_orders(status),sow_documents(id,status,version)`)
    .eq('workspace_id', session.workspaceId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })

  let accessibleProjectIds: string[] | null = null
  if (!canViewAll) {
    // FIX: project_members has neither workspace_id nor user_id columns —
    // see app/api/projects/route.ts for the full explanation. This
    // silently returned nothing for anyone without VIEW_ALL_PROJECTS.
    const { data: myIds } = await (service as any)
      .from('project_members').select('project_id, workspace_members!inner(user_id)')
      .eq('workspace_members.user_id', session.id)
    accessibleProjectIds = (myIds || []).map((r: any) => r.project_id)
    if (!accessibleProjectIds?.length) return <EmptyDash session={session} canCreate={canCreate} daysLeft={daysLeft} greetingText={greeting(ws?.timezone)} />
    projQuery = projQuery.in('id', accessibleProjectIds)
  }

  const { data: projects = [] } = await projQuery

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
  let activityQuery = (service as any)
    .from('audit_log').select('id,event_type,entity_name,actor_name,created_at,metadata')
    .eq('workspace_id', session.workspaceId)
    .not('project_id', 'is', null)
    .not('event_type', 'like', 'project_message.%')
    .order('created_at', { ascending: false }).limit(14)

  if (!canViewAll) {
    activityQuery = activityQuery.in('project_id', accessibleProjectIds || [])
  }

  const { data: activity = [] } = await activityQuery

  // FIX (section-11/12 audit — flagship feature gap): see lib/utils/attention.ts
  // — isAttentionWorthy() had no clause for a document stuck in an approval
  // chain at all. Fetched as its own query (rather than an embedded
  // approval_requests(...) on the projects select above) to keep the
  // pending-only filter simple and unambiguous — an embedded-resource
  // filter here would need care not to inner-join projects with zero
  // pending requests out of the result entirely.
  let pendingApprovalsQuery = (service as any)
    .from('approval_requests')
    .select('project_id, created_at')
    .eq('workspace_id', session.workspaceId)
    .eq('status', 'pending')
  if (!canViewAll) pendingApprovalsQuery = pendingApprovalsQuery.in('project_id', accessibleProjectIds || [])
  const { data: pendingApprovalRows = [] } = await pendingApprovalsQuery
  const pendingApprovalsByProject = new Map<string, Array<{ createdAt: string }>>()
  for (const r of (pendingApprovalRows || [])) {
    const list = pendingApprovalsByProject.get(r.project_id) || []
    list.push({ createdAt: r.created_at })
    pendingApprovalsByProject.set(r.project_id, list)
  }

  // Shared definition (lib/utils/project-status): includes Stalled, which the
  // dashboard used to drop while the Portfolio counted it.
  const active = (projects || []).filter((p: any) =>
    (IN_PROGRESS_STATUSES as readonly string[]).includes(p.status))
  const attention = (projects || []).filter((p: any) =>
    isAttentionWorthy({
      project: { ...p, contractValue: p.contract_value, stallReason: p.stall_reason,
        guardianFlags: p.guardian_flags, changeOrders: p.change_orders, sowDocuments: p.sow_documents,
        pendingApprovals: pendingApprovalsByProject.get(p.id) },
      workspace: { proactiveRiskAlertsEnabled: ws?.proactive_risk_alerts_enabled, proactiveRiskThreshold: ws?.proactive_risk_threshold, currency: ws?.currency },
    })
  )
  // FIX (deep audit, section 7): see currencyGroupedTotals in
  // lib/utils/format.ts — this used to sum contract_value across every
  // active project regardless of currency, then label the sum with
  // active[0]'s currency.
  const activeValueDisplay = formatCurrencyGroups(active, true, ws?.currency || 'USD')

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      {/* Trial banner */}
      {session.planTier === 'trial' && daysLeft !== null && daysLeft <= 5 && (
        <div className={`banner ${daysLeft <= 1 ? 'banner-danger' : 'banner-warn'}`}>
          <span>
            <strong>{daysLeft === 0 ? 'Trial expired.' : `${daysLeft} trial day${daysLeft !== 1 ? 's' : ''} remaining.`}</strong>
            {' '}{daysLeft === 0 ? 'Upgrade to restore full access.' : 'Upgrade to continue uninterrupted.'}
          </span>
          <Link href="/settings?tab=billing">
            <button className="btn btn-primary btn-sm">Upgrade now</button>
          </Link>
        </div>
      )}

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
            {PLAN_LABELS[session.planTier] || session.planTier}
          </div>
          <div className="mc-sub">
            {daysLeft !== null ? `${daysLeft} days remaining` : 'Active'}
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
                        project: { ...p, contractValue: p.contract_value, stallReason: p.stall_reason,
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
                            {p.contract_value ? formatCurrency(p.contract_value, p.currency) : '—'}
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
            {!(activity || []).length ? (
              <p style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', padding: '20px 0' }}>No activity yet</p>
            ) : (
              (activity || []).map((a: any) => (
                <div key={a.id} className="feed-item">
                  <div className="feed-dot" style={{ background: feedColour(a.event_type), marginTop: 6 }} />
                  <div className="feed-body">
                    <div className="feed-text">{formatEvent(a, canViewFinances)}</div>
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

function EmptyDash({ session, canCreate, daysLeft, greetingText }: { session: SessionUser; canCreate: boolean; daysLeft: number | null; greetingText: string }) {
  return (
    <div className="page" style={{ maxWidth: 980 }}>
      {session.planTier === 'trial' && daysLeft !== null && daysLeft <= 5 && (
        <div className="banner banner-warn">
          <span><strong>{daysLeft} trial days remaining.</strong> Upgrade to keep access.</span>
          <Link href="/settings?tab=billing">
            <button className="btn btn-primary btn-sm">Upgrade</button>
          </Link>
        </div>
      )}
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
