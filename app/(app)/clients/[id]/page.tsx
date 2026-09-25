import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { formatCurrency, formatCurrencyGroups, formatDate, projectStatusLabel } from '@/lib/utils/format'
import BillingDetailsCard from '@/components/clients/BillingDetailsCard'
import ClientContactCard from '@/components/clients/ClientContactCard'
import ClientContactsCard from '@/components/clients/ClientContactsCard'
import ArchiveClientButton from '@/components/clients/ArchiveClientButton'
import ClientDangerZone from '@/components/clients/ClientDangerZone'
import { IN_PROGRESS_STATUSES } from '@/lib/utils/project-status'
import { computeContractPositions } from '@/lib/reports/contract-position'

interface Props { params: Promise<{ id: string }> }

export default async function ClientDetailPage({ params }: Props) {
  const { id }  = await params
  const session = await getSession()
  if (!session) redirect('/login')

  const service = createServiceClient()
  const canViewClientData = hasPermission(session, 'VIEW_CLIENT_DATA')
  const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')

  const { data: client } = await (service as any)
    .from('clients')
    .select('*')
    .eq('id', id).eq('workspace_id', session.workspaceId).single()

  if (!client) notFound()

  // FIX (re-audit, cosmetic-gate finding): select('*') shipped email,
  // cc_emails, phone, vat_number, billing_address, and notes into the RSC
  // payload for every viewer, regardless of VIEW_CLIENT_DATA — the JSX
  // below only ever hid them, it never withheld them. Redact at the
  // source instead, same as the projects/[id] page.
  const canEditClientData = hasPermission(session, 'CREATE_PROJECTS')

  // FIX (deep audit, section 14): billing_address/vat_number were redacted
  // (and the card below hidden) behind VIEW_CLIENT_DATA alongside the real
  // contact-visibility fields (email/phone/cc_emails/notes) — but
  // api/clients/[id]/route.ts (see its own comment) deliberately treats
  // billing fields as CREATE_PROJECTS-only, independent of VIEW_CLIENT_DATA,
  // precisely because they aren't "contact data" in that sense. The result
  // was a backend allowance nobody could ever reach: a CREATE_PROJECTS-only
  // member could never see the current billing address/VAT number to edit
  // it, because the page redacted both fields and hid the card entirely
  // whenever VIEW_CLIENT_DATA was absent. Billing visibility now follows
  // the same either/or the API already grants: visible if the viewer can
  // see client data OR can edit it.
  const canSeeBilling = canViewClientData || canEditClientData
  if (!canViewClientData) {
    Object.assign(client, {
      email: null, cc_emails: null, phone: null,
      payment_terms_note: null, notes: null,
    })
  }
  if (!canSeeBilling) {
    Object.assign(client, { vat_number: null, billing_address: null })
  }

  // FEATURE (deep audit, section 14, finding #8): see
  // components/clients/ClientContactsCard.tsx for the full context —
  // client_contacts has existed in the schema since day one and is only
  // now getting a read/write surface. Same visibility gate as every other
  // contact-visibility field on this page (email/phone/cc_emails above).
  const { data: contacts = [] } = canViewClientData
    ? await (service as any)
        .from('client_contacts')
        .select('id,name,email,role,role_type,is_primary,created_at')
        .eq('client_id', id)
        .order('is_primary', { ascending: false })
        .order('created_at', { ascending: true })
    : { data: [] }

  // FIX (deep audit, section 14 — flagship finding): same project-
  // visibility gap as the clients list page — see that page's comment for
  // the full reasoning. This page additionally rendered a working link
  // straight into each project's detail page, which a limited-access
  // viewer would then get redirected/404'd out of — worse than just an
  // inflated count, since it invited a click into a page they can't open.
  const canViewAllProjects = hasPermission(session, 'VIEW_ALL_PROJECTS')
  let accessibleProjectIds: Set<string> | null = null
  if (!canViewAllProjects) {
    const { data: ids } = await (service as any)
      .from('project_members')
      .select('project_id, workspace_members!inner(user_id)')
      .eq('workspace_members.user_id', session.id)
    accessibleProjectIds = new Set((ids || []).map((r: { project_id: string }) => r.project_id))
  }

  const { data: projectsAll = [] } = await (service as any)
    .from('projects')
    .select('id,name,disc,type,status,contract_value,currency,retainer_duration_months,created_at,guardian_flags(status),change_orders(status),sow_documents(status)')
    .eq('client_id', id).eq('workspace_id', session.workspaceId).is('deleted_at', null)
    .order('created_at', { ascending: false })

  const projectsRaw = canViewAllProjects
    ? (projectsAll || [])
    : (projectsAll || []).filter((p: any) => accessibleProjectIds!.has(p.id))

  // Same fix for contract_value — was shipped unconditionally, only the
  // "Value" column and total below were ever gated in the UI.
  const projects = canViewFinancials
    ? projectsRaw
    : (projectsRaw || []).map((p: any) => ({ ...p, contract_value: null }))

  // FIX (deep audit, section 14 — flagship finding): this used to reduce()
  // contract_value across every one of the client's projects regardless
  // of currency, then label the sum with projects[0]'s currency — the
  // same bug class already fixed in dashboard/page.tsx and
  // ProjectsClient.tsx (see currencyGroupedTotals in lib/utils/format.ts)
  // but never applied to this page. A client with projects in more than
  // one currency got a single wrongly-labelled combined total. Group by
  // currency instead of picking one.
  const totalValueDisplay = canViewFinancials ? formatCurrencyGroups(projectsRaw || []) : ''
  const hasTotalValue = canViewFinancials && (projectsRaw || []).some((p: any) => (p.contract_value || 0) > 0)

  // FEATURE (deep audit, section 14): guardian_flags/change_orders/
  // sow_documents were already being joined into this exact query, but
  // none of it was ever rendered — looks like an abandoned attempt at
  // per-project status badges (this codebase uses the same pattern on
  // app/(app)/projects/page.tsx). Wiring it up rather than dropping the
  // now-explained dead join.
  // (was a local copy of this list — one shared definition now)
  const ACTIVE_STATUSES: readonly string[] = IN_PROGRESS_STATUSES
  const PENDING_CO_STATUSES = ['awaiting_response', 'countered', 'stalled', 'awaiting_countersignature', 'expired']
  function projectBadges(p: any) {
    const openFlags = (p.guardian_flags || []).filter((f: any) => f.status === 'open' || f.status === 'borderline_review').length
    const pendingCos = (p.change_orders || []).filter((co: any) => PENDING_CO_STATUSES.includes(co.status)).length
    // FIX (SOW lifecycle re-audit): 'sent' has never been a real
    // sow_documents.status value — lib/documents/send-sow.ts's own comment
    // spells out why (draft goes straight to 'awaiting_signature', spec
    // §1.3) — so this half of the check could never match anything. Dead,
    // harmless code masquerading as a second real condition; removed
    // rather than left implying a status this app doesn't have.
    const awaitingSow = (p.sow_documents || []).some((s: any) => s.status === 'awaiting_signature')
    return { openFlags, pendingCos, awaitingSow }
  }

  // Used to warn before archiving a client that still has active work —
  // see ArchiveClientButton.
  //
  // FIX (deep audit, section 14): this used to count against `projectsAll`
  // (unfiltered), the exact same disclosure this page's own flagship fix
  // above (canViewAllProjects/accessibleProjectIds) already treats as real
  // — "a real information disclosure, not a cosmetic one" — and fixes
  // everywhere else on this page (the table, the currency totals). A
  // member with CREATE_PROJECTS but only VIEW_OWN_PROJECTS got a
  // workspace-wide active-project count in the archive-warning dialog
  // instead of just the count of projects they can actually see. Use the
  // already-permission-filtered `projectsRaw` instead.
  const activeProjectCount = (projectsRaw || []).filter((p: any) => ACTIVE_STATUSES.includes(p.status)).length

  // ── FEATURE (independent pass, section 14): client-level money overview ──────────────────────
  // The page listed projects but never answered "what does this client owe me?". Reuses the same
  // computeContractPositions() the invoice PDFs and the rollup use (so the numbers can't disagree
  // with them), over ONLY the projects this viewer may see, grouped per currency. Outstanding =
  // unpaid balance of sent / partially-paid / overdue invoices (post-tax, what is actually owed).
  type Money = { contracted: number; invoiced: number; paid: number; outstanding: number; overdue: number; atRisk: number }
  const moneyByCurrency = new Map<string, Money>()
  if (canViewFinancials && (projectsRaw || []).length > 0) {
    try {
      const positions = await computeContractPositions(service, projectsRaw)
      const ids = (projectsRaw as any[]).map(p => p.id)
      const { data: openInvoices } = await (service as any)
        .from('invoices').select('project_id, amount, amount_paid, status')
        .in('project_id', ids).in('status', ['sent', 'partially_paid', 'overdue'])
      const cur = (pid: string) => (projectsRaw as any[]).find(p => p.id === pid)?.currency || 'USD'
      const bucket = (c: string): Money => {
        let m = moneyByCurrency.get(c)
        if (!m) { m = { contracted: 0, invoiced: 0, paid: 0, outstanding: 0, overdue: 0, atRisk: 0 }; moneyByCurrency.set(c, m) }
        return m
      }
      for (const p of projectsRaw as any[]) {
        const pos = positions.get(p.id); if (!pos) continue
        const m = bucket(p.currency || 'USD')
        m.contracted += pos.contractedValue; m.invoiced += pos.invoicedToDate; m.paid += pos.paidToDate; m.atRisk += pos.atRiskValue
      }
      for (const inv of (openInvoices || []) as any[]) {
        const owed = Math.max(0, (Number(inv.amount) || 0) - (Number(inv.amount_paid) || 0))
        const m = bucket(cur(inv.project_id))
        m.outstanding += owed
        if (inv.status === 'overdue') m.overdue += owed
      }
    } catch (e) { console.error('Client financial summary failed:', e) }
  }
  const showMoney = Array.from(moneyByCurrency.values()).some(m => m.invoiced > 0 || m.outstanding > 0 || m.contracted > 0)

  // ── Recent activity on the client record itself (needs VIEW_AUDIT_LOG) ──────────────────────
  const canViewAudit = hasPermission(session, 'VIEW_AUDIT_LOG')
  const { data: activity = [] } = canViewAudit
    ? await (service as any).from('audit_log')
        .select('id, event_type, actor_name, created_at, metadata')
        .eq('workspace_id', session.workspaceId).eq('entity_type', 'client').eq('entity_id', id)
        .order('created_at', { ascending: false }).limit(8)
    : { data: [] }
  const ACTIVITY_LABEL: Record<string, string> = {
    'client.created': 'Client created', 'client.updated': 'Details updated', 'client.merged': 'Merged another client into this one',
    'client.deleted': 'Deleted',
  }

  // ── Merge / delete controls ─────────────────────────────────────────────────────────────────
  const canDeleteClients = hasPermission(session, 'DELETE_PROJECTS')
  const canMergeClients = canEditClientData && canViewClientData && canDeleteClients
  const { data: mergeTargets = [] } = canMergeClients
    ? await (service as any).from('clients').select('id,name,email,status')
        .eq('workspace_id', session.workspaceId).neq('id', id).order('name').limit(500)
    : { data: [] }

  // FIX (independent pass round 2, section 14): DELETE /api/clients/[id] refuses when the client
  // has ANY project on record, explicitly including soft-deleted ones — but the Danger Zone below
  // used to gate the Delete button on the visible (non-deleted) project count alone. A client
  // whose only projects were soft-deleted showed the button as available, and clicking it always
  // 409'd with no way to see what was blocking it. Count all projects here (unfiltered by
  // deleted_at) so the UI can match the API's real eligibility check.
  const { count: totalProjectCount } = canDeleteClients
    ? await (service as any).from('projects').select('id', { count: 'exact', head: true })
        .eq('workspace_id', session.workspaceId).eq('client_id', id)
    : { count: 0 }

  function pillVariant(status: string): string {
    const m: Record<string, string> = {
      'Active': 'green', 'Awaiting Signature': 'amber', 'Changes Requested': 'amber',
      'Stalled': 'red', 'Complete': 'slate', 'Draft': 'slate', 'Intake': 'blue',
    }
    return m[status] || 'slate'
  }

  return (
    <div className="page" style={{ maxWidth: 960 }}>
      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        <Link href="/clients" style={{ fontSize: 12, color: 'var(--text-3)' }}>Clients</Link>
        <i className="ti ti-chevron-right" style={{ fontSize: 10, color: 'var(--text-4)' }} />
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{client.name}</span>
      </div>

      {/* Header */}
      <div className="page-hd">
        <div>
          <h1 className="page-title">
            {client.name}
            {client.status === 'archived' && (
              <span style={{ marginLeft: 10, fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'var(--bg-3)', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.4, verticalAlign: 'middle' }}>Archived</span>
            )}
          </h1>
          {client.company_name && (
            <p className="page-sub">{client.company_name}</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canEditClientData && <ArchiveClientButton clientId={id} status={client.status || 'active'} activeProjectCount={activeProjectCount} />}
          <Link href={`/projects/new?clientId=${id}`}>
            <button className="btn btn-primary">
              <i className="ti ti-plus" style={{ fontSize: 13 }} /> New project
            </button>
          </Link>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 24, alignItems: 'start' }}>
        {/* Projects */}
        <div>
          {showMoney && (
            <div style={{ marginBottom: 20 }}>
              <div className="sec-hd" style={{ marginBottom: 12 }}><div className="sec-title">Money</div></div>
              {Array.from(moneyByCurrency.entries()).map(([currency, m]) => (
                <div key={currency} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 10 }}>
                  {([
                    ['Contracted', m.contracted, false], ['Invoiced', m.invoiced, false], ['Paid', m.paid, false],
                    ['Outstanding', m.outstanding, m.outstanding > 0], ['Overdue', m.overdue, m.overdue > 0],
                    ['CO awaiting reply', m.atRisk, false],
                  ] as Array<[string, number, boolean]>).map(([label, value, warn]) => (
                    <div key={label} className="surface surface-p" style={{ padding: '10px 12px' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 3 }}>{label}{moneyByCurrency.size > 1 ? ` · ${currency}` : ''}</div>
                      <div style={{ fontSize: 15, fontWeight: 500, fontFamily: 'IBM Plex Mono, monospace', color: label === 'Overdue' && warn ? 'var(--red)' : label === 'Outstanding' && warn ? 'var(--amber)' : undefined }}>
                        {formatCurrency(value, currency)}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="sec-hd" style={{ marginBottom: 12 }}>
            <div className="sec-title">Projects ({(projects || []).length})</div>
            {hasTotalValue && (
              <span style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'IBM Plex Mono, monospace' }}>
                {totalValueDisplay} total
              </span>
            )}
          </div>
          {!(projects || []).length ? (
            <div className="surface">
              <div className="empty-state" style={{ padding: '40px 24px' }}>
                <i className="ti ti-folder-open empty-state-icon" style={{ fontSize: 28 }} />
                <p className="empty-state-title">No projects yet</p>
                <Link href={`/projects/new?clientId=${id}`}>
                  <button className="btn btn-primary btn-sm">Create first project</button>
                </Link>
              </div>
            </div>
          ) : (
            <div className="surface" style={{ overflow: 'hidden' }}>
              <table className="gov-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Status</th>
                    {canViewFinancials && <th style={{ textAlign: 'right' }}>Value</th>}
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {(projects || []).map((p: any) => {
                    const badges = projectBadges(p)
                    return (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/projects/${p.id}`}>
                          <div className="td-primary">{p.name}</div>
                          {p.disc && <div className="td-sub">{p.disc}</div>}
                        </Link>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                          <span className={`pill pill-${pillVariant(p.status)}`}>
                            {projectStatusLabel(p.status)}
                          </span>
                          {badges.openFlags > 0 && (
                            <span className="pill pill-red pill-sm" title="Open Guardian flags needing review">
                              {badges.openFlags} flag{badges.openFlags !== 1 ? 's' : ''}
                            </span>
                          )}
                          {badges.pendingCos > 0 && (
                            <span className="pill pill-amber pill-sm" title="Change order awaiting resolution">
                              {badges.pendingCos} CO pending
                            </span>
                          )}
                          {badges.awaitingSow && (
                            <span className="pill pill-blue pill-sm" title="SOW sent, awaiting signature">SOW pending</span>
                          )}
                        </div>
                      </td>
                      {canViewFinancials && (
                        <td className="td-mono" style={{ textAlign: 'right', fontSize: 12 }}>
                          {p.contract_value ? formatCurrency(p.contract_value, p.currency) : '—'}
                        </td>
                      )}
                      <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatDate(p.created_at)}</td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Contact card + notes */}
        <div>
          {canViewClientData ? (
            <ClientContactCard
              clientId={client.id}
              name={client.name}
              companyName={client.company_name}
              email={client.email}
              phone={client.phone}
              ccEmails={client.cc_emails}
              paymentTermsNote={client.payment_terms_note}
              notes={client.notes}
              timezone={client.timezone}
              emailBouncedAt={client.email_bounced_at}
              emailBounceKind={client.email_bounce_kind}
              editable={canEditClientData}
            />
          ) : (
            <>
              <div className="sec-hd" style={{ marginBottom: 12 }}><div className="sec-title">Contact details</div></div>
              <div className="surface surface-p" style={{ marginBottom: 16 }}>
                <p style={{ fontSize: 13, color: 'var(--text-3)', fontStyle: 'italic', textAlign: 'center', padding: '16px 0' }}>
                  Restricted — requires VIEW_CLIENT_DATA permission
                </p>
              </div>
            </>
          )}

          {canViewClientData && (
            <ClientContactsCard
              clientId={client.id}
              contacts={contacts || []}
              editable={canEditClientData}
            />
          )}

          {/* Phase 11: billing address + VAT — feeds the "Bill To" block on
              every Invoice/SOW/CO PDF for this client (lib/pdf/renderer.tsx).
              Gated on canSeeBilling (VIEW_CLIENT_DATA OR CREATE_PROJECTS),
              not canViewClientData alone — see the redaction comment above. */}
          {canSeeBilling && (
            <BillingDetailsCard
              clientId={client.id}
              vatNumber={client.vat_number}
              billingAddress={client.billing_address}
              editable={canEditClientData}
            />
          )}

          <div style={{ marginTop: 20 }}>
            <div className="sec-hd" style={{ marginBottom: 12 }}><div className="sec-title">Client since</div></div>
            <div className="surface surface-p">
              <p style={{ fontSize: 13, color: 'var(--text-2)', margin: 0 }}>{formatDate(client.created_at)}</p>
            </div>
          </div>

          {canViewAudit && (activity || []).length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div className="sec-hd" style={{ marginBottom: 12 }}><div className="sec-title">Recent activity</div></div>
              <div className="surface surface-p">
                {(activity || []).map((a: any) => (
                  <div key={a.id} className="settings-row" style={{ alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ fontSize: 12.5 }}>{ACTIVITY_LABEL[a.event_type] || a.event_type}</div>
                      {Array.isArray(a.metadata?.fields) && a.metadata.fields.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{a.metadata.fields.join(', ')}</div>
                      )}
                      <div style={{ fontSize: 11, color: 'var(--text-4)' }}>{a.actor_name} · {formatDate(a.created_at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <ClientDangerZone
            clientId={client.id} clientName={client.name} visibleProjectCount={(projectsRaw || []).length}
            totalProjectCount={totalProjectCount || 0}
            others={(mergeTargets || []).map((c: any) => ({ id: c.id, name: c.name, email: c.email, status: c.status }))}
            canMerge={canMergeClients} canDelete={canEditClientData && canDeleteClients}
          />
        </div>
      </div>
    </div>
  )
}
