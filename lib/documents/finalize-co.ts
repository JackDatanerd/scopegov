// lib/documents/finalize-co.ts
// FIX (doc-completeness audit): extracted from the original
// portal/co/[token]/accept route so the same "mark accepted, create
// amendment, resolve flag, generate PDF, notify everyone" logic can be
// shared by both acceptance paths:
//   1. Client directly accepts the CO as sent (status: awaiting_response)
//   2. Client countersigns after the agency accepted their counter-offer
//      (status: awaiting_countersignature — see migration 014)
// Previously (2) had none of this: no PDF, no client email, no amendment
// created with a captured client signature. This is now the single place
// both flows go through so they can't drift apart again.

import { logAudit } from '@/lib/utils/audit'
import { renderCoPdf } from '@/lib/pdf/renderer'
import { sendCoAcceptedEmail, sendCoAcceptedClientEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'

export async function finalizeCoAcceptance(service: any, params: {
  co: any                 // change_orders row joined with projects/clients/workspaces, plus resolved `total`
  signerName: string
  signatureData: string
  source: 'direct' | 'countersignature'
  // FIX (doc-completeness audit, finding #2): sow_documents.signer_ip has
  // been captured on every SOW signature since 001_initial_schema.sql;
  // change_orders had no equivalent column and neither acceptance path
  // captured an IP at all, despite a CO amendment being just as legally
  // binding as the original SOW. Optional (not required) so any other
  // caller of this shared finalizer doesn't break if it can't resolve one.
  signerIp?: string | null
  // FIX (re-audit, race-condition finding): the status this CO must
  // currently be in for this acceptance to be valid — 'awaiting_response'
  // for a direct accept, 'countered' for the agency-side accept-counter,
  // 'awaiting_countersignature' for a client countersignature. Every
  // caller already reads and checks co.status before calling this
  // function, but that read-then-write gap is exactly the race window:
  // two near-simultaneous requests (a double-click, or a client's
  // browser silently retrying a timed-out fetch — both routine on a
  // portal signing page) can each pass the caller's status check before
  // either write lands, then both run this entire function. Requiring
  // the UPDATE below to still match that expected status turns the
  // whole finalize into a compare-and-swap: only the request that
  // actually flips the row proceeds past it.
  expectedStatus: string
}) {
  const { co, signerName, signatureData, source, signerIp, expectedStatus } = params
  const project = co.projects
  const client  = project.clients
  const ws      = project.workspaces
  const now     = new Date().toISOString()

  const { data: signedSow } = await (service as any)
    .from('sow_documents')
    .select('id')
    .eq('project_id', co.project_id)
    .eq('status', 'signed')
    .order('version', { ascending: false })
    .limit(1).single()

  if (!signedSow)
    return { ok: false as const, error: 'No signed SOW found for this project — cannot record this amendment', status: 422 }

  // Compare-and-swap: only succeeds if the row is still in the status the
  // caller observed. A concurrent request that already flipped it (or beat
  // us here) makes this match zero rows — `data` comes back empty, not an
  // error — which is the race-loser signal checked right below.
  const { data: updatedCo, error: updateErr } = await (service as any)
    .from('change_orders')
    .update({
      status:                'accepted',
      accepted_at:           now,
      accepted_by:           signerName.trim(),
      client_signature_data: signatureData,
      signer_ip:             signerIp || 'unknown',
      responded_at:          now,
      updated_at:            now,
    })
    .eq('id', co.id)
    .eq('status', expectedStatus)
    .select('id')

  if (updateErr)
    return { ok: false as const, error: 'Failed to record acceptance', status: 500 }
  if (!updatedCo || updatedCo.length === 0)
    return { ok: false as const, error: 'This change order was already accepted', status: 409 }

  const lineItems    = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])
  const deliverables = lineItems.map((l: any) => l.description).filter(Boolean)

  const { error: amendErr } = await (service as any).from('amendments').insert({
    project_id:           co.project_id,
    workspace_id:         co.workspace_id,
    change_order_id:      co.id,
    signed_sow_id:        signedSow.id,
    title:                source === 'countersignature' ? `Amendment — ${co.title} (counter accepted)` : `Amendment — ${co.title}`,
    added_deliverables:   deliverables,
    removed_deliverables: [],
    financial_impact:     co.total,
    effective_at:         now,
    // Note: no async job ever populated this (see doc-completeness audit
    // finding #9) — left as '' deliberately. The durable, always-current
    // copy of this CO is available on demand via /api/pdf/co/[id]
    // (agency) and /api/portal/co/[token]/pdf (client), both rendered
    // fresh from the DB rather than a stored file that could go stale.
    pdf_path:             '',
  })
  if (amendErr) console.error('Amendment insert failed after CO accept:', amendErr, { coId: co.id })

  try {
    const { data: snap } = await (service as any)
      .from('project_scope_snapshot').select('id,deliverables').eq('project_id', co.project_id).single()
    if (snap && deliverables.length) {
      await (service as any).from('project_scope_snapshot').update({
        deliverables:    [...(snap.deliverables || []), ...deliverables.map((d: string) => ({ title: d }))],
        last_updated_at: now,
        last_updated_by: 'amendment',
      }).eq('project_id', co.project_id)
    }
  } catch (e) { console.error('Snapshot update failed:', e) }

  if (co.flag_id) {
    await (service as any).from('guardian_flags').update({
      status: 'resolved', resolution: 'change_order',
      resolved_at: now, updated_at: now,
    }).eq('id', co.flag_id)
  }

  await logAudit(service, {
    workspaceId: co.workspace_id, actorId: client.email,
    actorEmail: client.email, actorName: signerName.trim(),
    eventType: 'co.accepted', entityType: 'change_order',
    entityId: co.id, entityName: co.title,
    metadata: { total: co.total, signer: signerName.trim(), flag_resolved: !!co.flag_id, source, signer_ip: signerIp || 'unknown' },
  })

  // Build the accepted-CO PDF once, reused for both the agency and client
  // confirmation emails — same pattern as the SOW sign route.
  let pdfAttachment: { filename: string; content: string } | undefined
  try {
    let logoUrl: string | null = null
    if (ws.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }
    const pdfBuffer = await renderCoPdf({
      agencyName:    ws.agency_name,
      logoUrl,
      brandColour:   ws.brand_colour || '#1A5C3A',
      agencyAddress: ws.legal_address || null,
      agencyTaxId:   ws.tax_id || null,
      agencyPhone:   ws.phone || null,
      agencyWebsite: ws.website || null,
      clientName:    client.name,
      clientCompany: client.company_name || null,
      clientBillingAddress: client.billing_address || null,
      clientVatNumber:      client.vat_number || null,
      projectName:   project.name,
      coTitle:       co.title,
      note:          co.note || null,
      lineItems,
      subtotal:      co.subtotal,
      taxRate:       co.tax_rate,
      taxInclusive:  co.tax_inclusive,
      total:         co.total,
      currency:      project.currency || 'USD',
      acceptedBy:    signerName.trim(),
      acceptedAt:    now,
      agencySignatureData: ws.agency_signature_data || null,
      clientSignatureData: signatureData,
      documentNumber: co.document_number || null,
    })
    pdfAttachment = { filename: `CO-${project.name.replace(/[^a-z0-9]/gi, '-')}.pdf`, content: pdfBuffer.toString('base64') }
  } catch (e) { console.error('CO PDF generation for email failed (emails will send without attachment):', e) }

  try {
    const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_accepted', co.project_id)
    if (emails.length) {
      await sendCoAcceptedEmail({
        to: emails, agencyName: ws.agency_name,
        clientName: client.name, projectName: project.name,
        coTitle: co.title, total: co.total, currency: project.currency || 'USD',
        acceptedBy: signerName.trim(),
        projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
      })
    }
  } catch (e) { console.error('CO accepted agency email failed:', e) }

  // FIX (doc-completeness audit): the CO's accept token is marked
  // 'superseded' in revoked_tokens the moment it's used (so it can't be
  // replayed to accept/decline/counter again) — which means the ordinary
  // portal page for this token would show a generic "link deactivated"
  // screen, not a happy confirmation. Point the CTA straight at the PDF
  // endpoint instead, which explicitly allows a 'superseded' token through
  // read-only once the CO is 'accepted' (see the pdf route for why).
  try {
    if (client?.email) {
      const pdfUrl = `${process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL}/api/portal/co/${co.token || ''}/pdf`
      await sendCoAcceptedClientEmail({
        to: client.email, cc: client.cc_emails || [],
        clientName: client.name, agencyName: ws.agency_name,
        projectName: project.name, coTitle: co.title,
        total: co.total, currency: project.currency || 'USD',
        portalUrl: pdfUrl,
        attachments: pdfAttachment ? [pdfAttachment] : undefined,
      })
    }
  } catch (e) { console.error('CO accepted client email failed:', e) }

  await notifyMembersWithPermission(service, {
    workspaceId: co.workspace_id, permission: 'SEND_CHANGE_ORDERS', eventType: 'co_accepted',
    type: 'co_accepted', title: `CO accepted — ${co.title}`,
    body: `${signerName.trim()} accepted ${project.currency || 'USD'} ${co.total} for ${project.name}.`,
    entityType: 'project', entityId: co.project_id, projectId: co.project_id,
  })

  return { ok: true as const, agencyName: ws.agency_name }
}
