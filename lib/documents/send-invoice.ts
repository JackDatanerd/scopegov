// lib/documents/send-invoice.ts
// FIX (section-12 audit — flagship feature gap): extracted from
// app/api/invoices/[id]/send/route.ts, same pattern as send-sow.ts /
// send-co.ts, so evaluateApprovalGate()'s auto-send-on-final-approval can
// send an invoice the exact same way a direct click does — PDF attachment,
// contract-position snapshot, and internal notification included, unlike
// the leaner SOW/CO extraction (invoices deliberately attach a PDF to the
// very first email; SOW/CO don't, since the client has to visit the portal
// anyway to sign). Keeping this rich rather than trimming it to match
// SOW/CO's shape avoids a foreseeable regression: an approval-gated
// invoice's auto-sent email silently becoming link-only while a directly-
// sent one keeps its PDF.
//
// This file intentionally contains ONLY the send mechanics — no permission
// checks, no approval-gate logic, no due-date/payment-instructions
// completeness validation. Callers are responsible for all of that.

import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { sendInvoiceEmail, sendInvoiceSentInternalEmail } from '@/lib/email/templates'
import { logAudit } from '@/lib/utils/audit'
import { assignDocumentNumber } from '@/lib/utils/document-number'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { renderInvoicePdf } from '@/lib/pdf/renderer'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'

export type SendInvoiceResult =
  | { ok: true; token: string; portalUrl: string; invoiceNumber: string; projectId: string; projectName: string }
  | { ok: false; error: string; status: number }

export async function sendInvoiceDocument(service: any, params: {
  invoiceId: string
  workspaceId: string
  actorId: string
  actorEmail: string
  actorName: string
  actorAgencyName?: string
  // Present when this send was triggered by an approval chain clearing,
  // rather than a direct user click — carried into the audit metadata.
  approvalRequestId?: string
}): Promise<SendInvoiceResult> {
  const { invoiceId, workspaceId, actorId, actorEmail, actorName, actorAgencyName, approvalRequestId } = params

  const { data: invoice, error: fetchErr } = await (service as any)
    .from('invoices')
    .select(`id, title, amount, currency, status, due_date, payment_instructions, invoice_number,
      po_number, milestone_id, project_id, subtotal, tax_rate, tax_inclusive, line_items, sow_id, co_id,
      projects(id, name, client_id, clients(name, email, cc_emails, company_name, billing_address, vat_number),
        workspaces(id, agency_name, brand_colour, logo_storage_path, legal_address, tax_id, phone, website)),
      sow_documents(document_number), change_orders(document_number, title)`)
    .eq('id', invoiceId).eq('workspace_id', workspaceId).single()

  if (!invoice) {
    console.error('Invoice send: lookup failed', { invoiceId, workspaceId, error: fetchErr })
    return { ok: false, error: 'Invoice not found', status: 404 }
  }
  if (invoice.status !== 'draft') return { ok: false, error: 'Only draft invoices can be sent', status: 400 }

  const project   = invoice.projects
  const client    = project?.clients
  const workspace = project?.workspaces

  if (!client?.email) return { ok: false, error: 'Client email required', status: 400 }
  if (!invoice.due_date) return { ok: false, error: 'Add a due date before sending this invoice.', status: 400 }
  if (!invoice.payment_instructions?.trim())
    return { ok: false, error: 'Add payment instructions before sending this invoice.', status: 400 }

  const jwtSecret = await getWorkspaceJwtSecret(service, workspaceId)
  if (!jwtSecret) return { ok: false, error: 'Workspace signing secret not found', status: 500 }
  const secret    = new TextEncoder().encode(jwtSecret)
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
  const token     = await new SignJWT({
    invoiceId,
    workspaceId,
    projectId:   project.id,
    clientEmail: client.email,
    action:      'view',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(expiresAt)
    .setJti(nanoid())
    .sign(secret)

  const now = new Date().toISOString()

  const invoiceNumber = invoice.invoice_number || await assignDocumentNumber(service, workspaceId, 'invoice')

  // Same CAS pattern as send-sow.ts / send-co.ts — survives a double-click
  // or two near-simultaneous triggers (manual Send + approval-engine
  // auto-send).
  const { data: sent, error: updateErr } = await (service as any).from('invoices').update({
    status:         'sent',
    sent_at:        now,
    token,
    expires_at:     expiresAt.toISOString(),
    invoice_number: invoiceNumber,
    updated_at:     now,
  }).eq('id', invoiceId).eq('status', 'draft').select('id').maybeSingle()

  if (updateErr) {
    console.error('Invoice send: update failed', updateErr)
    return { ok: false, error: 'Failed to send invoice', status: 500 }
  }
  if (!sent) return { ok: false, error: 'This invoice was already sent by another action', status: 409 }

  const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/invoice/${token}`

  let contractPosition: { contractedValue: number; invoicedToDate: number; paidToDate: number } | null = null
  if (invoice.project_id) {
    const { data: snapshot } = await (service as any)
      .from('contract_reconciliation_snapshots')
      .select('contracted_value, invoiced_to_date, paid_to_date')
      .eq('project_id', invoice.project_id)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (snapshot) {
      contractPosition = {
        contractedValue: snapshot.contracted_value || 0,
        invoicedToDate:  snapshot.invoiced_to_date || 0,
        paidToDate:      snapshot.paid_to_date || 0,
      }
    }
  }

  let pdfAttachment: { filename: string; content: string } | undefined
  try {
    let logoUrl: string | null = null
    if (workspace?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(workspace.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }
    let milestoneTrigger: string | null = null
    if (invoice.milestone_id) {
      const { data: milestone } = await (service as any)
        .from('payment_milestones').select('trigger').eq('id', invoice.milestone_id).single()
      milestoneTrigger = milestone?.trigger || null
    }
    const pdfBuffer = await renderInvoicePdf({
      agencyName:    workspace.agency_name || actorAgencyName,
      logoUrl,
      brandColour:   workspace.brand_colour || '#1A5C3A',
      agencyAddress: workspace.legal_address || null,
      agencyTaxId:   workspace.tax_id || null,
      agencyPhone:   workspace.phone || null,
      agencyWebsite: workspace.website || null,
      clientName:    client.name,
      clientCompany: client.company_name || null,
      clientBillingAddress: client.billing_address || null,
      clientVatNumber:      client.vat_number || null,
      poNumber:      invoice.po_number || null,
      milestoneTrigger,
      projectName:   project.name,
      invoiceNumber,
      title:         invoice.title,
      amount:        invoice.amount,
      amountPaid:    0,
      subtotal:      invoice.subtotal,
      taxRate:       invoice.tax_rate,
      taxInclusive:  invoice.tax_inclusive,
      currency:      invoice.currency,
      status:        'sent',
      dueDate:       invoice.due_date,
      sentAt:        now,
      paymentInstructions: invoice.payment_instructions,
      sowNumber:  invoice.sow_documents?.document_number || null,
      coNumber:   invoice.change_orders?.document_number || null,
      coTitle:    invoice.change_orders?.title || null,
      lineItems:  typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : (invoice.line_items || []),
      payments:      [],
      contractPosition,
    })
    pdfAttachment = { filename: `${invoiceNumber || 'Invoice'}-${project.name.replace(/[^a-z0-9]/gi, '-')}.pdf`, content: pdfBuffer.toString('base64') }
  } catch (e) { console.error('Invoice PDF generation for email failed (email will send without attachment):', e) }

  try {
    await sendInvoiceEmail({
      to:          client.email,
      cc:          client.cc_emails || [],
      clientName:  client.name,
      agencyName:  workspace.agency_name,
      projectName: project.name,
      invoiceNumber,
      title:       invoice.title,
      amount:      invoice.amount,
      currency:    invoice.currency,
      dueDate:     invoice.due_date,
      portalUrl,
      brandColour: workspace.brand_colour,
      paymentInstructions: invoice.payment_instructions,
      attachments: pdfAttachment ? [pdfAttachment] : undefined,
    })
  } catch (e) { console.error('Invoice email failed:', e) }

  await logAudit(service, {
    workspaceId, actorId, actorEmail, actorName,
    eventType: 'invoice.sent', entityType: 'invoice',
    entityId: invoiceId, entityName: invoice.title,
    metadata: {
      amount: invoice.amount, client_email: client.email, invoice_number: invoiceNumber,
      ...(approvalRequestId ? { auto_sent_via_approval: approvalRequestId } : {}),
    },
  })

  await notifyMembersWithPermission(service, {
    workspaceId, permission: 'VIEW_FINANCIALS',
    eventType: 'invoice_sent',
    type: 'invoice_sent',
    title: `Invoice sent — ${project.name}`,
    body: `${client.name} was sent an invoice for ${invoice.currency} ${invoice.amount.toLocaleString()} on "${invoice.title}".`,
    entityType: 'project', entityId: project.id, excludeUserId: actorId, projectId: project.id,
  })
  try {
    const emails = await getMemberEmailsWithPermission(service, workspaceId, 'VIEW_FINANCIALS', 10, 'invoice_sent', project.id)
    if (emails.length) {
      await sendInvoiceSentInternalEmail({
        to: emails, clientName: client.name, projectName: project.name,
        invoiceNumber, amount: invoice.amount, currency: invoice.currency,
        projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=billing`,
      })
    }
  } catch (e) { console.error('Invoice sent internal email failed:', e) }

  return { ok: true, token, portalUrl, invoiceNumber, projectId: project.id, projectName: project.name }
}
