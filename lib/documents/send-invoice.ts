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
// checks, no approval-gate logic, no payment-instructions completeness
// validation. Callers are responsible for all of that.
//
// FIX (re-audit, section-12 finding): due-date-in-the-past IS re-checked here
// (see isDueDateInPast below), unlike every other completeness rule in this
// file. The direct-send route (app/api/invoices/[id]/send) already refuses a
// stale due date before asking anyone to approve, specifically so an invoice
// can't wait days in a chain and arrive already overdue — but that check ran
// once, at submission. The auto-send this function serves when a chain
// clears (lib/approvals/engine.ts's dispatchSend) never re-ran it, so a due
// date that was fine when submitted could — and, given the stall cron's
// multi-day reminder/escalation windows, routinely would — go stale while
// still waiting on an approver, and ship to the client silently overdue on
// arrival with no error surfaced anywhere. Re-checking here, right before
// the send actually happens, covers both callers at once and folds into the
// existing "approved — not sent, retry once fixed" flow other send failures
// already use — no new UI needed.

import { resolveInvoiceSowNumber } from '@/lib/documents/invoice-refs'
import { computeContractPosition } from '@/lib/reports/contract-position'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { sendInvoiceEmail, sendInvoiceSentInternalEmail } from '@/lib/email/templates'
import { logAudit } from '@/lib/utils/audit'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { renderInvoicePdf } from '@/lib/pdf/renderer'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { resolveReplyTo } from '@/lib/email/reply-to'
import { checkedSend } from '@/lib/email/delivery'
import { formatMoney } from '@/lib/utils/money'
import { isDueDateInPast } from '@/lib/documents/preflight'

export type SendInvoiceResult =
  | { ok: true; token: string; portalUrl: string; invoiceNumber: string; projectId: string; projectName: string; emailSent: boolean; emailError?: string }
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
  /** The amount the approval chain signed off on (context.amount). When given, an invoice that has since changed size is not sent. */
  approvedGateAmount?: number | null
}): Promise<SendInvoiceResult> {
  const { invoiceId, workspaceId, actorId, actorEmail, actorName, actorAgencyName, approvalRequestId } = params

  const { data: invoice, error: fetchErr } = await (service as any)
    .from('invoices')
    .select(`id, title, amount, currency, status, due_date, payment_instructions, invoice_number,
      po_number, milestone_id, project_id, subtotal, tax_rate, tax_inclusive, line_items, sow_id, co_id,
      projects(id, name, client_id, deleted_at, clients(name, email, cc_emails, company_name, billing_address, vat_number, payment_terms_note),
        workspaces(id, timezone, agency_name, brand_colour, logo_storage_path, legal_address, tax_id, phone, website)),
      sow_documents(document_number), payment_milestones(sow_documents(document_number)), change_orders(document_number, title)`)
    .eq('id', invoiceId).eq('workspace_id', workspaceId).single()

  if (!invoice) {
    console.error('Invoice send: lookup failed', { invoiceId, workspaceId, error: fetchErr })
    return { ok: false, error: 'Invoice not found', status: 404 }
  }
  if (invoice.status !== 'draft') return { ok: false, error: 'Only draft invoices can be sent', status: 400 }

  // FIX (section-11 pass, approved-amount re-check): sendCoDocument refuses to auto-send a CO whose size no longer matches what
  // the approval chain signed off on; this path had no equivalent. The edit lock (PATCH /api/invoices/[id]) reads the approval
  // state and then writes through update_invoice_capped, which guards only on status='draft' — so an edit landing in the instant
  // a send-for-approval was created (or a slow, reordered autosave) could change the amount AFTER it was submitted, and the
  // auto-send would then put an unapproved figure in front of the client with a freshly assigned invoice number. Refuse it here,
  // before a number is consumed; the requester cancels the request and sends again at the real amount.
  if (params.approvedGateAmount != null && Number.isFinite(Number(params.approvedGateAmount))) {
    const current = Math.abs(Number(invoice.amount) || 0)
    if (Math.abs(current - Math.abs(Number(params.approvedGateAmount))) > 0.005)
      return { ok: false, status: 409, error: 'This invoice was edited after it was submitted for approval, so the approved amount no longer matches. Cancel this request and send it again for approval.' }
  }

  const project   = invoice.projects
  const client    = project?.clients
  const workspace = project?.workspaces

  // FIX (section-12 audit, pass 2): SOW/CO sends refuse a soft-deleted project;
  // this one never selected deleted_at, so an invoice could be sent (or an
  // approval-failed send retried) for a project sitting in the trash.
  if (project?.deleted_at) return { ok: false, error: 'This project has been deleted, so its invoices can no longer be sent.', status: 400 }

  if (!client?.email) return { ok: false, error: 'Client email required', status: 400 }
  if (!invoice.due_date) return { ok: false, error: 'Add a due date before sending this invoice.', status: 400 }
  if (isDueDateInPast(invoice.due_date))
    return { ok: false, error: 'The due date has passed since this was submitted — change the due date (the approval stays in place), then retry the send.', status: 400 }
  if (!invoice.payment_instructions?.trim())
    return { ok: false, error: 'Add payment instructions before sending this invoice.', status: 400 }

  // FIX (deep audit, section 14 — flagship finding): see
  // lib/utils/client-contacts.ts — the client's designated primary
  // contact, if any, is now CC'd alongside cc_emails rather than never
  // being consulted at all.
  const invoiceSowNumber = await resolveInvoiceSowNumber(service, invoice)
  const ccEmails = await withPrimaryContactCc(service, project.client_id, client.email, client.cc_emails, 'invoice')

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

  // FIX (section-12 audit, pass 2): a milestone can only be billed once. The
  // create-time check and migration 069's unique index stop a second live
  // invoice, but an older duplicate (created before either existed) could still
  // be sent here and bill the same deliverable twice. Refuse if a DIFFERENT
  // invoice against this milestone has already gone out.
  if (invoice.milestone_id) {
    const { data: already } = await (service as any)
      .from('invoices').select('id').eq('milestone_id', invoice.milestone_id)
      .neq('id', invoiceId).not('status', 'in', '(draft,void)').limit(1)
    if (already && already.length > 0)
      return { ok: false, error: 'This milestone has already been invoiced by another invoice — void that one first if you need to re-bill it.', status: 409 }
  }

  // FIX (section-12 audit, pass 2): the invoice number used to be claimed FIRST
  // (assignDocumentNumber — a separate transaction that advances the workspace
  // sequence) and the draft->sent guard ran afterwards. A double-click, a manual
  // send racing the approval auto-send, or a failed update all burned a number
  // — a gap in a sequence many tax regimes require to be unbroken — and the
  // assignment itself was unwrapped, so a throw escaped to the approval engine
  // (send-sow/send-co wrap theirs). Now ONE transaction: lock the row, check it
  // is still a draft, take the next number, flip it to sent (migration 069). NULL
  // means it was not a draft any more and no number was consumed.
  const { data: finalNumber, error: finalizeErr } = await (service as any).rpc('finalize_invoice_send', {
    p_invoice_id: invoiceId, p_workspace_id: workspaceId,
    p_token: token, p_expires_at: expiresAt.toISOString(), p_now: now,
  })
  if (finalizeErr) {
    console.error('Invoice send: finalize failed', finalizeErr)
    return { ok: false, error: 'Failed to send invoice', status: 500 }
  }
  if (!finalNumber) return { ok: false, error: 'This invoice was already sent by another action', status: 409 }
  const invoiceNumber: string = finalNumber

  const portalUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/portal/invoice/${token}`

  // Computed LIVE (lib/reports/contract-position.ts), not read from the nightly snapshot: the snapshot
  // can never include the invoice being rendered right now, and mis-stated retainers.
  let contractPosition: { contractedValue: number; invoicedToDate: number; paidToDate: number } | null = null
  if (invoice.project_id) {
    const position = await computeContractPosition(service, invoice.project_id)
    if (position) contractPosition = { contractedValue: position.contractedValue, invoicedToDate: position.invoicedToDate, paidToDate: position.paidToDate }
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
    // FIX (section-12 independent pass — bug): timeZone was never passed, so the emailed PDF printed "Issued"
    // and "Generated" in UTC while the downloadable and portal copies print them in the workspace's own zone.
    const pdfBuffer = await renderInvoicePdf({
      timeZone:      workspace.timezone,
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
      clientPaymentTerms:   client.payment_terms_note || null,
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
      sowNumber:  invoiceSowNumber,
      coNumber:   invoice.change_orders?.document_number || null,
      coTitle:    invoice.change_orders?.title || null,
      lineItems:  typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : (invoice.line_items || []),
      payments:      [],
      contractPosition,
    })
    pdfAttachment = { filename: `${invoiceNumber || 'Invoice'}-${project.name.replace(/[^a-z0-9]/gi, '-')}.pdf`, content: pdfBuffer.toString('base64') }
  } catch (e) { console.error('Invoice PDF generation for email failed (email will send without attachment):', e) }

  // FIX (Notifications & email fix round): the Resend SDK never throws, so
  // the old try/catch here could not detect a rejected send and the invoice
  // was reported as delivered. This now follows the SOW/CO contract
  // (lib/documents/send-sow.ts): the invoice stays 'sent' — the portal link is
  // valid and can be copied — and the caller is told the email did not go
  // out so the UI can say so and offer the link.
  const replyTo = await resolveReplyTo(service, workspaceId, actorEmail)
  const delivery = await checkedSend(() => sendInvoiceEmail({
    to:          client.email,
    cc:          ccEmails,
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
    paymentTerms: client.payment_terms_note || null,
    attachments: pdfAttachment ? [pdfAttachment] : undefined,
    replyTo,
    log:         { workspaceId, kind: 'invoice.send', entityType: 'invoice', entityId: invoiceId, projectId: project.id, actorId },
  }), 'Invoice send email', { requireRecipient: true })

  await logAudit(service, {
    workspaceId, actorId, actorEmail, actorName,
    eventType: 'invoice.sent', entityType: 'invoice',
    entityId: invoiceId, entityName: invoice.title,
    metadata: {
      amount: invoice.amount, client_email: client.email, invoice_number: invoiceNumber,
      ...(approvalRequestId ? { auto_sent_via_approval: approvalRequestId } : {}),
    },
  })

  // The team notice says the client WAS sent the invoice. When the provider rejected the email the invoice is still
  // 'sent' (its portal link is live) but the client received nothing, so announcing it to teammates — bell and email —
  // was false. The sender is told through `emailError`; teammates hear nothing until it is actually delivered.
  if (delivery.ok) {
    await notifyMembersWithPermission(service, {
      workspaceId, permission: 'VIEW_FINANCIALS',
      eventType: 'invoice_sent',
      type: 'invoice_sent',
      title: `Invoice sent — ${project.name}`,
      body: `${client.name} was sent an invoice for ${formatMoney(invoice.amount, invoice.currency)} on "${invoice.title}".`,
      entityType: 'project', entityId: project.id, excludeUserId: actorId, projectId: project.id,
    })
    try {
      const emails = await getMemberEmailsWithPermission(service, workspaceId, 'VIEW_FINANCIALS', 25, 'invoice_sent', project.id, actorId)
      if (emails.length) {
        await sendInvoiceSentInternalEmail({
          to: emails, clientName: client.name, projectName: project.name,
          invoiceNumber, amount: invoice.amount, currency: invoice.currency,
          projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=billing`,
        })
      }
    } catch (e) { console.error('Invoice sent internal email failed:', e) }

  }

  return {
    ok: true, token, portalUrl, invoiceNumber, projectId: project.id, projectName: project.name,
    emailSent: delivery.ok, ...(delivery.ok ? {} : { emailError: delivery.error }),
  }
}
