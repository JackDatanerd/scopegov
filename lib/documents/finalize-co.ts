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

import { resolveReplyTo } from '@/lib/email/reply-to'
import { logAudit } from '@/lib/utils/audit'
import { renderCoPdf } from '@/lib/pdf/renderer'
import { renewalTermForDocument } from '@/lib/documents/co-renewal-term'
import { sendCoAcceptedEmail, sendCoAcceptedClientEmail } from '@/lib/email/templates'
import { formatMoney } from '@/lib/utils/money'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { checkedSend } from '@/lib/email/delivery'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { computeContentHash, storeExecutedPdf } from '@/lib/documents/executed-pdf'
import { isAdjustmentLine } from '@/lib/utils/rescale-line-items'
import { parseStoredLineItems } from '@/lib/documents/co-totals'
import { coPdfFilename } from '@/lib/documents/co-pdf-name'
import { getContractValueBefore } from '@/lib/documents/co-contract-value'
import { createHash } from 'node:crypto'
import { isTerminalStatus } from '@/lib/utils/project-status'
import { findSignedSow, SIGNED_SOW_LOOKUP_FAILED } from '@/lib/documents/signed-sow'
import { sanitizeRichTextOrNull } from '@/lib/utils/sanitize'

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
  // A CO the client answers while it is 'stalled' (agency-side attention flag, not a client lock) is
  // accepted from that state too.
  expectedStatus: string | string[]
}) {
  const { co, signerName, signatureData, source, signerIp, expectedStatus } = params
  const project = co.projects
  const client  = project.clients
  const ws      = project.workspaces
  const now     = new Date().toISOString()

  // FIX (section 3+10 independent audit): same terminal-status check as
  // send-co.ts / accept-co-counter.ts. This shared finalizer covers both
  // client-acceptance paths (direct accept and countersignature after an
  // agency-accepted counter) and was, until now, the one CO-finalizing
  // action with no terminal-project guard at all — every route that
  // *creates or sends* a CO, and the agency-side acceptance of a client's
  // counter, all check this, but a client's own Accept/Countersign click
  // did not. A project marked Complete/Archived while a CO was still out
  // for signature could still have that CO signed here, creating a
  // binding amendment (and, for a retainer renewal, silently rewriting
  // contract_value) on a project the rest of the app treats as closed to
  // scope changes.
  if (project && isTerminalStatus(project.status)) {
    return {
      ok: false as const,
      error: `This project is ${String(project.status).toLowerCase()} — a change order can no longer be accepted. Reopen the project first.`,
      status: 409,
    }
  }

  // A failed read must not tell the client (who has just completed the signing ritual) that no signed SOW exists. This
  // runs before the status compare-and-swap, so a retry is clean.
  const sowLookup = await findSignedSow(service, co.project_id, { newest: true })
  if (!sowLookup.ok) return { ok: false as const, error: SIGNED_SOW_LOOKUP_FAILED, status: 500 }
  const signedSow = sowLookup.sow

  if (!signedSow)
    return { ok: false as const, error: 'No signed SOW found for this project — cannot record this amendment', status: 422 }

  // Compare-and-swap: only succeeds if the row is still in the status the
  // caller observed. A concurrent request that already flipped it (or beat
  // us here) makes this match zero rows — `data` comes back empty, not an
  // error — which is the race-loser signal checked right below.
  // The rate a retainer renewal REPLACES has to be read before anything overwrites it.
  const isRenewal = !!co.is_retainer_renewal && project.type === 'retainer'
  let previousContractValue: number | null = project.contract_value != null ? Number(project.contract_value) : null
  if (isRenewal) {
    const { data: freshProject } = await (service as any)
      .from('projects').select('contract_value').eq('id', co.project_id).single()
    if (freshProject?.contract_value != null) previousContractValue = Number(freshProject.contract_value)
  }

  const casUpdate = (service as any)
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
  const { data: updatedCo, error: updateErr } = await (Array.isArray(expectedStatus)
    ? casUpdate.in('status', expectedStatus)
    : casUpdate.eq('status', expectedStatus)
  ).select('id')

  if (updateErr) {
    // The client only ever sees the generic message, and this used to be swallowed entirely — so a
    // failing CAS (missing column, constraint, trigger) was undiagnosable from the logs.
    console.error('CO acceptance CAS update failed:', {
      coId: co.id, source, expectedStatus,
      code: updateErr.code, message: updateErr.message, details: updateErr.details, hint: updateErr.hint,
    })
    return { ok: false as const, error: 'Failed to record acceptance', status: 500 }
  }
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
  if (isRenewal) {
    const { error: renewalErr } = await (service as any)
      .from('projects')
      .update({ contract_value: co.total, updated_at: now })
      .eq('id', co.project_id)
    if (renewalErr) {
      console.error('Retainer renewal contract_value update failed after CO accept:', renewalErr, { coId: co.id })
    } else {
      // FEATURE (cron/portal audit round 2): extend the retainer's term by the renewal's stated months (see
      // lib/documents/renewal-term.ts). Compare-and-set on the value we read so two renewals accepted at the same
      // moment can't overwrite each other's extension. The renewal has already been accepted and the rate already
      // replaced, so a failure here is logged loudly, not returned as an error to the client.
      let termExtension: { from: number; to: number } | null = null
      let openEndedRetainer = false
      const termMonths = Number((co as any).renewal_term_months) || 0
      if (termMonths > 0) {
        for (let attempt = 0; attempt < 3 && !termExtension; attempt++) {
          const { data: fresh } = await (service as any)
            .from('projects').select('retainer_duration_months').eq('id', co.project_id).single()
          const current = fresh?.retainer_duration_months
          if (current == null) { openEndedRetainer = true; break } // open-ended retainer: nothing to extend
          const next = Number(current) + termMonths
          const { data: bumped, error: bumpErr } = await (service as any).from('projects')
            .update({ retainer_duration_months: next, updated_at: now })
            .eq('id', co.project_id).eq('retainer_duration_months', current).select('id')
          if (bumpErr) { console.error('Retainer term extension failed after CO accept:', bumpErr, { coId: co.id }); break }
          if (bumped?.length) termExtension = { from: Number(current), to: next }
        }
        if (!termExtension && !openEndedRetainer) console.error('Retainer renewal accepted but the term was not extended — check the project by hand', { coId: co.id, termMonths })
      }
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
        metadata: {
          change_order_id: co.id, new_monthly_amount: co.total, currency: project.currency || 'USD',
          renewal_term_months: termMonths || null, term_extended_from: termExtension?.from ?? null, term_extended_to: termExtension?.to ?? null,
        },
      })
    }
  }

  const lineItems    = parseStoredLineItems(co.line_items)
  const isCredit     = !!co.is_credit && !isRenewal
  // Scope deliverables come from real work lines only. The system-written "Negotiated discount…" line
  // (counter-offers) and a retainer renewal's rate line are pricing, not scope — they were being
  // appended to the Guardian baseline as if they were deliverables.
  // A credit / descope CO does the opposite: its lines are the deliverables being REMOVED from scope.
  const workLines: string[] = lineItems.filter((l: any) => !isAdjustmentLine(l)).map((l: any) => String(l.description || '').trim()).filter(Boolean)
  const deliverables: string[] = isRenewal || isCredit ? [] : workLines
  const removedDeliverables: string[] = isCredit ? workLines : []

  // A renewal REPLACES the monthly rate (contract_value above); recording its total as a financial
  // impact as well double-counted it — effective value is contract_value + Σ amendments, so every
  // renewal counted twice everywhere that total is used (project page, reconciliation, the CO's
  // own "before" value). Its impact is therefore zero; the old rate is kept for the record.
  const amendmentRow: Record<string, unknown> = {
    project_id:           co.project_id,
    workspace_id:         co.workspace_id,
    change_order_id:      co.id,
    signed_sow_id:        signedSow.id,
    title:                isRenewal
      ? `Amendment — ${co.title} (retainer rate renewal)`
      : isCredit ? `Credit — ${co.title}`
      : source === 'countersignature' ? `Amendment — ${co.title} (counter accepted)` : `Amendment — ${co.title}`,
    added_deliverables:   deliverables,
    removed_deliverables: removedDeliverables,
    financial_impact:     isRenewal ? 0 : co.total,
    effective_at:         now,
    pdf_path:             '',
  }
  let { error: amendErr } = await (service as any).from('amendments').insert({
    ...amendmentRow, ...(isRenewal ? { previous_contract_value: previousContractValue } : {}),
  })
  // Deployments that have not applied migration 061 yet lack previous_contract_value — retry without it.
  if (amendErr && isRenewal) {
    ;({ error: amendErr } = await (service as any).from('amendments').insert(amendmentRow))
  }
  if (amendErr) {
    console.error('Amendment insert failed after CO accept:', amendErr, { coId: co.id })
    // The client has signed and the CO is 'accepted', but the amendment (which feeds the effective
    // contract value) is missing. Leave an explicit, findable record instead of a console line.
    await logAudit(service, {
      workspaceId: co.workspace_id, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
      eventType: 'co.amendment_failed', entityType: 'change_order', entityId: co.id, entityName: co.title,
      metadata: { project_id: co.project_id, total: co.total, error: amendErr.message || String(amendErr) },
    })
  }

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

      // FIX (re-audit, section 18): mirrors the SOW sign route's identical fix (cron/portal audit
      // round 3) — the result of this write was never read. On a failure the row kept the OLD token
      // while `coToken` (the link emailed to the client, and the value both accept/route.ts and
      // countersign/route.ts return as `result.token`) pointed at the NEW one — a confirmation email
      // AND the browser's own post-accept redirect both landing on a token that was never persisted.
      // Both callers also unconditionally mark the OLD token 'superseded' right after this returns,
      // so a failed reissue would leave the CO resolvable by neither the (unswitched) old token nor
      // the (never-saved) new one. Only switch over once the write has actually landed; otherwise the
      // original link stays in effect (it still resolves the accepted/countersigned document, and the
      // callers below now skip the supersede-insert when the token didn't actually change).
      const { error: reissueErr } = await (service as any).from('change_orders').update({
        token: newToken, expires_at: newExpiresAt.toISOString(),
      }).eq('id', co.id)
      if (reissueErr) throw new Error(`token reissue write failed: ${reissueErr.message}`)
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
    if (removedDeliverables.length) {
      const { error: removeErr } = await (service as any).rpc('remove_scope_deliverables', {
        p_project_id: co.project_id,
        p_removed:    removedDeliverables,
        p_now:        now,
      })
      if (removeErr) console.error('remove_scope_deliverables failed:', removeErr, { coId: co.id, projectId: co.project_id })
    }
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
    // FIX (deep audit, CO logic independent re-pass): this wrote by flag id alone, so a CO
    // that shared a flag_id with a different live CO (see app/api/co/route.ts) resolved the
    // OTHER CO's flag on acceptance. Only resolve a flag that is still in play (converted_to_co,
    // or 'open' for older COs created through the create route, which never claimed it) and
    // linked to THIS CO or to nothing. Anything else is another CO's, or already resolved.
    await (service as any).from('guardian_flags').update({
      status: 'resolved', resolution: 'change_order',
      resolved_at: now, updated_at: now,
    }).eq('id', co.flag_id).in('status', ['converted_to_co', 'open'])
      .or(`change_order_id.eq.${co.id},change_order_id.is.null`)
  }

  const contentHash = computeContentHash({
    kind: 'co', coId: co.id, version: co.version ?? null, projectId: co.project_id,
    title: co.title, note: co.note || null, lineItems, subtotal: co.subtotal,
    taxRate: co.tax_rate, taxInclusive: co.tax_inclusive, total: co.total, currency: project.currency || 'USD',
    timelineImpactDays: co.timeline_impact_days ?? null, scopeImpactNote: co.scope_impact_note || null,
    isRetainerRenewal: isRenewal, previousContractValue, ...(isCredit ? { isCredit: true } : {}),
    // CO-1: the term is part of what the client agreed to, so it is part of the fingerprint (renewals only, so every other
    // document's hash recipe - and every hash already stored - is unchanged).
    ...(isRenewal && renewalTermForDocument(co, project) ? { renewalTermMonths: renewalTermForDocument(co, project) } : {}),
    acceptedBy: signerName.trim(), acceptedAt: now, source, signerEmail: client.email,
    signatureSha256: createHash('sha256').update(signatureData).digest('hex'),
  })

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
    metadata: { total: co.total, signer: signerName.trim(), flag_resolved: !!co.flag_id, source, signer_ip: signerIp || 'unknown', content_hash: contentHash, ...(isRenewal ? { retainer_renewal: true, previous_monthly_amount: previousContractValue } : {}) },
  })

  // Build the accepted-CO PDF once, reused for both the agency and client
  // confirmation emails — same pattern as the SOW sign route.
  let pdfBuffer: Buffer | null = null
  let pdfAttachment: { filename: string; content: string } | undefined
  try {
    let logoUrl: string | null = null
    if (ws.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }
    // Same inputs the downloadable copy uses, so the executed original and every later download are
    // the same document. (This copy used to omit the SOW number and the Value-impact block.)
    const revisedContractValue = isRenewal ? Number(co.total) : null
    const contractValueBefore = isRenewal
      ? previousContractValue
      : await getContractValueBefore(service, co.project_id, co.id, project.contract_value != null ? Number(project.contract_value) : null, { project })
    // FIX (section-12 trace — bug, CO side): the executed copy never got the workspace timezone, so its
    // "Accepted" and "Generated" dates printed in UTC (a CO accepted 00:00-03:00 EAT showed the previous day)
    // while every later download printed them in the workspace's zone. Looked up here because the callers'
    // workspace selects don't all carry it.
    let timeZone: string | null = null
    try {
      const { data: tzRow } = await (service as any).from('workspaces').select('timezone').eq('id', co.workspace_id).maybeSingle()
      timeZone = tzRow?.timezone ?? null
    } catch { /* falls back to UTC, as before */ }
    pdfBuffer = await renderCoPdf({
      timeZone,
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
      // Same two inputs the live download route (api/pdf/co/[id]) passes, so the frozen executed copy and a later live
      // render of the same accepted CO print identically: the status badge, and the note re-sanitized on the way out.
      status:        'accepted',
      note:          sanitizeRichTextOrNull(co.note),
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
      sowNumber:          signedSow.document_number || null,
      contractValueBefore,
      isRetainerRenewal:  isRenewal,
      revisedContractValue,
      renewalTermMonths:  isRenewal ? renewalTermForDocument(co, project) : null,
      version:            co.version ?? null,
      isCredit,
    })
    pdfAttachment = { filename: coPdfFilename(co.document_number, co.title), content: pdfBuffer.toString('base64') }
  } catch (e) { console.error('CO PDF generation for email failed (emails will send without attachment):', e) }

  // Freeze the executed copy + fingerprint (see lib/documents/executed-pdf.ts). Separate updates so a
  // deployment without migration 061 still degrades gracefully.
  if (pdfBuffer) {
    const storedPath = await storeExecutedPdf(service, { workspaceId: co.workspace_id, kind: 'co', id: co.id, buffer: pdfBuffer })
    if (storedPath) {
      const { error: pathErr } = await (service as any).from('change_orders').update({ pdf_path: storedPath }).eq('id', co.id)
      if (pathErr) console.error('CO accept: pdf_path update failed (is migration 061 applied?):', pathErr.message)
      await (service as any).from('amendments').update({ pdf_path: storedPath }).eq('change_order_id', co.id)
    }
  }
  const { error: hashErr } = await (service as any).from('change_orders').update({ content_hash: contentHash }).eq('id', co.id)
  if (hashErr) console.error('CO accept: content_hash update failed (is migration 061 applied?):', hashErr.message)

  const emails = await getMemberEmailsWithPermission(service, co.workspace_id, 'SEND_CHANGE_ORDERS', 25, 'co_accepted', co.project_id).catch(() => [] as string[])
  if (emails.length) {
    await checkedSend(() => sendCoAcceptedEmail({
      to: emails,
      clientName: client.name, projectName: project.name,
      coTitle: co.title, total: co.total, currency: project.currency || 'USD',
      acceptedBy: signerName.trim(),
      projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${co.project_id}?tab=co`,
      attachments: pdfAttachment ? [pdfAttachment] : undefined,
      isCredit,
    }), 'CO accepted (agency) email')
  }

  if (client?.email) {
    const portalBase = process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL
    const portalUrl  = `${portalBase}/portal/co/${coToken || ''}`
    const acceptedCc = await withPrimaryContactCc(service, project.client_id, client.email, client.cc_emails, 'co')
    const replyTo = await resolveReplyTo(service, co.workspace_id, null)
    await checkedSend(() => sendCoAcceptedClientEmail({
      replyTo,
      to: client.email, cc: acceptedCc,
      clientName: client.name, agencyName: ws.agency_name,
      projectName: project.name, coTitle: co.title,
      total: co.total, currency: project.currency || 'USD',
      portalUrl,
      attachments: pdfAttachment ? [pdfAttachment] : undefined,
      isCredit,
      log: { workspaceId: co.workspace_id, kind: 'co.accepted_confirmation', entityType: 'change_order', entityId: co.id, projectId: co.project_id },
    }), 'CO accepted (client) email')
  }

  await notifyMembersWithPermission(service, {
    workspaceId: co.workspace_id, permission: 'SEND_CHANGE_ORDERS', eventType: 'co_accepted',
    type: 'co_accepted', title: `CO accepted — ${co.title}`,
    body: isCredit
      ? `${signerName.trim()} accepted a credit of ${formatMoney(Math.abs(Number(co.total) || 0), project.currency)} for ${project.name}.`
      : `${signerName.trim()} accepted ${formatMoney(co.total, project.currency)} for ${project.name}.`,
    entityType: 'project', entityId: co.project_id, projectId: co.project_id,
  })

  return { ok: true as const, agencyName: ws.agency_name, token: coToken }
}
