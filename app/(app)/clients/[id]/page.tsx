import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { formatCurrency, formatDate, projectStatusLabel } from '@/lib/utils/format'
import BillingDetailsCard from '@/components/clients/BillingDetailsCard'
import ClientContactCard from '@/components/clients/ClientContactCard'
import ArchiveClientButton from '@/components/clients/ArchiveClientButton'

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
  if (!canViewClientData) {
    Object.assign(client, {
      email: null, cc_emails: null, phone: null,
      vat_number: null, billing_address: null,
      payment_terms_note: null, notes: null,
    })
  }

  const canEditClientData = hasPermission(session, 'CREATE_PROJECTS')

  const { data: projectsRaw = [] } = await (service as any)
    .from('projects')
    .select('id,name,disc,type,status,contract_value,currency,created_at,guardian_flags(status),change_orders(status),sow_documents(status)')
    .eq('client_id', id).eq('workspace_id', session.workspaceId).is('deleted_at', null)
    .order('created_at', { ascending: false })

  // Same fix for contract_value — was shipped unconditionally, only the
  // "Value" column and total below were ever gated in the UI.
  const projects = canViewFinancials
    ? projectsRaw
    : (projectsRaw || []).map((p: any) => ({ ...p, contract_value: null }))

  const totalValue = canViewFinancials
    ? (projectsRaw || []).reduce((s: number, p: any) => s + (p.contract_value || 0), 0)
    : 0
  const currency   = (projects || [])[0]?.currency || 'USD'

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
          {canEditClientData && <ArchiveClientButton clientId={id} status={client.status || 'active'} />}
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
          <div className="sec-hd" style={{ marginBottom: 12 }}>
            <div className="sec-title">Projects ({(projects || []).length})</div>
            {canViewFinancials && totalValue > 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'IBM Plex Mono, monospace' }}>
                {formatCurrency(totalValue, currency)} total
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
                  {(projects || []).map((p: any) => (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/projects/${p.id}`}>
                          <div className="td-primary">{p.name}</div>
                          {p.disc && <div className="td-sub">{p.disc}</div>}
                        </Link>
                      </td>
                      <td>
                        <span className={`pill pill-${pillVariant(p.status)}`}>
                          {projectStatusLabel(p.status)}
                        </span>
                      </td>
                      {canViewFinancials && (
                        <td className="td-mono" style={{ textAlign: 'right', fontSize: 12 }}>
                          {p.contract_value ? formatCurrency(p.contract_value, p.currency) : '—'}
                        </td>
                      )}
                      <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{formatDate(p.created_at)}</td>
                    </tr>
                  ))}
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

          {/* Phase 11: billing address + VAT — feeds the "Bill To" block on
              every Invoice/SOW/CO PDF for this client (lib/pdf/renderer.tsx) */}
          {canViewClientData && (
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
        </div>
      </div>
    </div>
  )
}
