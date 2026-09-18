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
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'

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

  // FIX (section-11/12 audit — cross-section bug): change_orders.is_retainer_renewal
  // is a real, user-facing checkbox ("This is a retainer renewal" in
  // CoEditor.tsx) that was captured and persisted but never acted on
  // anywhere. Every accepted CO's financial impact — retainer renewals
  // included — only ever landed in the amendments table below; nothing
  // ever touched projects.contract_value. That's correct for an ordinary
  // scope-adding CO (amendments is the additive ledger on top of the
  // original contract_value), but app/api/cron/retainer-milestones/route.ts
  // reads contract_value LIVE, every month, AS the current monthly
  // retainer amount — it has no concept of amendments at all. So a client
  // could sign a CO explicitly marked as a retainer-rate renewal, and the
  // monthly auto-generated billing milestone would keep invoicing them at
  // the ORIGINAL rate forever, silently, with nothing anywhere ever
  // surfacing the discrepancy. Scoped to type:'retainer' projects only —
  // for a fixed-fee project this flag shouldn't be checked in the first
  // place, and blindly overwriting a fixed contract_value here would be
  // its own bug. The CO's total is treated as the new absolute monthly
  // rate (an agency drafts this as a single "New monthly retainer rate"
  // line item), not a delta on top of the old one — consistent with how
  // the checkbox reads and with there being no separate "increase by"
  // field anywhere in the CO editor.
  if (co.is_retainer_renewal && project.type === 'retainer') {
    const { error: renewalErr } = await (service as any)
      .from('projects')
      .update({ contract_value: co.total, updated_at: now })
      .eq('id', co.project_id)
    if (renewalErr) {
      console.error('Retainer renewal contract_value update failed after CO accept:', renewalErr, { coId: co.id })
    } else {
      await logAudit(service, {
        // FIX (build, Reports & Audit re-pass): actor_id is `uuid
        // REFERENCES users(id)` — client.email is not a valid uuid, so
        // this insert failed silently (unchecked supabase-js error) and
        // 'project.retainer_renewed' never reached audit_log. null is
        // correct for a non-platform-user actor; actorEmail/actorName
        // already carry the real identity.
        workspaceId: co.workspace_id, actorId: null,
        actorEmail: client.email, actorName: signerName.trim(),
        eventType: 'project.retainer_renewed', entityType: 'project',
        entityId: co.project_id, entityName: project.name,
        metadata: { change_order_id: co.id, new_monthly_amount: co.total, currency: project.currency || 'USD' },
      })
    }
  }

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

  // FIX (re-audit, portal section): the accept token expires a flat 30
  // days from when the CO was *sent* (send-co.ts) and, unlike
  // accept-counter, direct acceptance never reissued it — so the PDF
  // redownload link below (which reuses the same token) went dead a fixed
  // 30 days post-send regardless of how close to that deadline the client
  // actually accepted. Reissuing a fresh, long-lived token here brings
  // direct-accept to parity with accept-counter's existing behavior.
  let coToken = co.token
  try {
    const jwtSecret = await getWorkspaceJwtSecret(service, co.workspace_id)
    if (jwtSecret) {
      const secret = new TextEncoder().encode(jwtSecret)
      const newExpiresAt = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000) // 2 years
      const newToken = await new SignJWT({
        coId: co.id, workspaceId: co.workspace_id, projectId: co.project_id,
        clientEmail: client.email, action: 'view',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setExpirationTime(newExpiresAt)
        .setJti(nanoid())
        .sign(secret)

      await (service as any).from('change_orders').update({
        token: newToken, expires_at: newExpiresAt.toISOString(),
      }).eq('id', co.id)
      coToken = newToken
    }
  } catch (e) { console.error('CO post-acceptance token reissue failed (original link stays in effect):', e) }

  try {
    // FIX (section-10 audit, race-condition finding): this used to be a
    // plain read-then-write — select deliverables, spread them locally,
    // write the concatenated array back. Two COs on the same project
    // accepted close together (two open portal tabs, an accept-counter
    // landing seconds after a direct accept elsewhere) raced: both read
    // the same starting array, and whichever write landed second silently
    // discarded the first's newly-added deliverables from the snapshot,
    // with no error anywhere. Migration 043's append_scope_deliverables
    // does the concatenation as a single atomic UPDATE under Postgres's
    // own row lock instead, so a concurrent acceptance always appends to
    // whatever the other one just wrote rather than to a stale local copy.
    //
    // FIX (deep audit, section 13 — cross-cutting): this call used to be a
    // bare `await (service as any).rpc(...)` with the result discarded
    // entirely. supabase-js does NOT throw on a Postgres-side error from
    // an RPC call — it resolves normally with `{ data, error }` — so a
    // failing function call (see migration 045's note: 043's function had
    // a jsonb/jsonb[] type mismatch that failed on every real invocation)
    // never tripped this try/catch, never logged anything, and never told
    // anyone the scope snapshot didn't actually get updated. Capture and
    // check `error` explicitly so a broken snapshot write is at least
    // visible in server logs instead of indistinguishable from success.
    if (deliverables.length) {
      const { error: appendErr } = await (service as any).rpc('append_scope_deliverables', {
        p_project_id: co.project_id,
        p_added:      deliverables.map((d: string) => ({ title: d })),
        p_now:        now,
      })
      if (appendErr) console.error('append_scope_deliverables failed:', appendErr, { coId: co.id, projectId: co.project_id })
    }
  } catch (e) { console.error('Snapshot update failed:', e) }

  if (co.flag_id) {
    await (service as any).from('guardian_flags').update({
      status: 'resolved', resolution: 'change_order',
      resolved_at: now, updated_at: now,
    }).eq('id', co.flag_id)
  }

  await logAudit(service, {
    // FIX (build, Reports & Audit re-pass): actor_id is `uuid REFERENCES
    // users(id)` — client.email is not a valid uuid, so this insert
    // failed silently (unchecked supabase-js error) and 'co.accepted' —
    // a client accepting a change order — never once reached audit_log.
    // null is correct for a non-platform-user actor; actorEmail/actorName
    // already carry the real identity.
    workspaceId: co.workspace_id, actorId: null,
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
      timelineImpactDays: co.timeline_impact_days ?? null,
      scopeImpactNote:    co.scope_impact_note || null,
    })
    pdfAttachment = { filename: `CO-${project.name.replace(/[^a-z0-9]/gi, '-')}.pdf`, content: pdfBuffer.toString('base64') }
  } catch (e) { console.error('CO PDF generation for email failed (emails will send without attachment):', e) }

  try {
    const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_accepted', co.project_id)
    if (emails.length) {
      // FIX (re-audit, notifications section): pdfAttachment was already
      // generated above (used for the client email 20 lines below) but
      // was never passed here — the client got a PDF copy of the executed
      // change order, the agency team that just closed the deal didn't,
      // and had to go find it in the app separately.
      await sendCoAcceptedEmail({
        to: emails,
        clientName: client.name, projectName: project.name,
        coTitle: co.title, total: co.total, currency: project.currency || 'USD',
        acceptedBy: signerName.trim(),
        projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
        attachments: pdfAttachment ? [pdfAttachment] : undefined,
      })
    }
  } catch (e) { console.error('CO accepted agency email failed:', e) }

  // FIX (portal audit, section 18 — closing pass): this used to point the
  // client CTA straight at the raw /pdf endpoint, reasoning that the
  // ORIGINAL accept token is marked 'superseded' the moment it's used and
  // would show a generic "link deactivated" screen on the ordinary portal
  // page. That reasoning doesn't apply to the token actually used here:
  // `coToken` (above) is the FRESH, non-revoked token reissued at the top
  // of this function — the exact same mechanism the SOW sign route uses,
  // which correctly links its own client confirmation email to the real
  // portal page, not a raw PDF. app/api/portal/co/[token]/route.ts's
  // GET handler has a dedicated `state === 'accepted'` branch — "built for
  // exactly this case" per its own comment — that renders a branded
  // thank-you with the captured signature AND a Download PDF button, i.e.
  // a strict superset of what the raw PDF link offered. Linking straight
  // to the PDF skipped that confirmation experience for every CO client,
  // unlike every SOW client. Point at the portal page (same URL shape
  // send-co.ts/accept-co-counter.ts already use for their own links);
  // the page itself offers the PDF download.
  try {
    if (client?.email) {
      const portalBase = process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL
      const portalUrl  = `${portalBase}/portal/co/${coToken || ''}`
      await sendCoAcceptedClientEmail({
        to: client.email, cc: client.cc_emails || [],
        clientName: client.name, agencyName: ws.agency_name,
        projectName: project.name, coTitle: co.title,
        total: co.total, currency: project.currency || 'USD',
        portalUrl,
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

  return { ok: true as const, agencyName: ws.agency_name, token: coToken }
}
