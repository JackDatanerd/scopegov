export const runtime = 'nodejs'

import { resolveReplyTo } from '@/lib/email/reply-to'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { logAudit } from '@/lib/utils/audit'
import { sendSowSignedAgencyEmail, sendSowSignedClientEmail } from '@/lib/email/templates'
import { renderSowPdf } from '@/lib/pdf/renderer'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getWorkspaceJwtSecret, isWorkspaceDeleted } from '@/lib/utils/workspace-secret'
import { checkRevokedToken, verifySowJwt } from '../_shared'
import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'
import { cleanTextField } from '@/lib/utils/sanitize'
import { isValidSignatureImage } from '@/lib/utils/signature'
import { checkedSend } from '@/lib/email/delivery'
import { withPrimaryContactCc } from '@/lib/utils/client-contacts'
import { computeContentHash, storeExecutedPdf } from '@/lib/documents/executed-pdf'
import { createHash } from 'node:crypto'
import { createSowMilestones, ensureGuardianEmail, writeScopeSnapshot } from '@/lib/documents/post-signing'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }      = await params
    const service        = createServiceClient()
    // FEATURE (portal audit, section 18): see migration 030 — this route
    // had no rate limiting at all before this.
    const clientIp = getClientIp(request)
    const rl = await checkPortalRateLimit(service, clientIp, 'sow.sign')
    if (!rl.allowed) return NextResponse.json({ error: rl.message }, { status: 429 })
    await recordPortalAction(service, clientIp, 'sow.sign')

    const reqBody = await request.json().catch(() => null)
    if (!reqBody || typeof reqBody !== 'object')
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    const signerName = cleanTextField((reqBody as any).signerName, 120)
    const signatureData = (reqBody as any).signatureData
    // The audit trail records where the signature came from: the real client hop, not the raw
    // x-forwarded-for chain (which can carry several comma-separated addresses).
    const ip = clientIp || 'unknown'

    if (!signerName || signerName.length < 3)
      return NextResponse.json({ error: 'Full name required to sign' }, { status: 400 })
    // Only genuine PNG/JPEG data: an SVG or corrupt image would be stored and then make every
    // later render of this executed document throw. See lib/utils/signature.ts.
    if (!isValidSignatureImage(signatureData))
      return NextResponse.json({ error: 'Please draw your signature to sign' }, { status: 400 })

    // Check revoked
    const { revoked } = await checkRevokedToken(service, token)
    if (revoked) return NextResponse.json({ error: 'This link is no longer active' }, { status: 410 })

    // Fetch SOW
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, status, sections, metadata, expires_at, project_id, workspace_id, document_number,
        projects(id, name, disc, currency, contract_value, client_id, created_by, guardian_email,
          clients(name, email, cc_emails, company_name, billing_address, vat_number),
          workspaces(id, agency_name, brand_colour, logo_storage_path, agency_signature_data,
            first_sow_signed_at, legal_address, tax_id, phone, website))`)
      .eq('token', token).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    if (sow.status !== 'awaiting_signature')
      return NextResponse.json({ error: 'This SOW is no longer awaiting signature' }, { status: 409 })
    if (sow.expires_at && new Date(sow.expires_at) < new Date())
      return NextResponse.json({ error: 'This link has expired' }, { status: 410 })

    // Verify JWT — jwt_secret lives in workspace_secrets now, not on
    // workspaces itself — see migration 013.
    if (!(await verifySowJwt(service, token, sow.workspace_id)))
      return NextResponse.json({ error: 'Invalid or expired signing link' }, { status: 401 })

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — flagship
    // finding): see isWorkspaceDeleted's own comment. Without this, a SOW
    // still 'awaiting_signature' when the agency deletes the workspace
    // could be signed anyway, creating a real signed document, milestones,
    // and emails against a workspace that no longer has any active member.
    if (await isWorkspaceDeleted(service, sow.workspace_id))
      return NextResponse.json({ error: 'This link is no longer active' }, { status: 410 })

    const now     = new Date().toISOString()
    const project = sow.projects
    const client  = project.clients
    const ws      = project.workspaces

    // One executed SOW per project. A second signature would create a second set of payment
    // milestones (double billing) and re-point the Guardian address; scope changes to a signed
    // agreement go through change orders.
    const { data: otherSigned } = await (service as any)
      .from('sow_documents').select('id').eq('project_id', project.id).neq('id', sow.id).eq('status', 'signed').limit(1)
    if (otherSigned && otherSigned.length > 0)
      return NextResponse.json({ error: 'This project already has a signed agreement.' }, { status: 409 })

    // ── 1. Mark SOW signed ───────────────────────────────────
    // FIX (re-audit, race-condition finding): the status check above
    // (`sow.status !== 'awaiting_signature'`) reads then this writes —
    // two near-simultaneous requests (a double-click, or a browser
    // silently retrying a timed-out fetch on the signing page, both
    // routine here) can both pass that read before either write lands,
    // then both run this entire flow: two sets of milestones, two PDFs,
    // duplicate agency/client emails, and a duplicate INSERT attempt on
    // project_scope_snapshot below (which does have a UNIQUE(project_id)
    // constraint, so the *second* request would previously crash with an
    // unhandled DB error instead of failing cleanly). CAS on status here
    // closes the window: only the request that actually flips the row
    // continues past this point.
    const { data: updatedSow, error: signUpdateErr } = await (service as any)
      .from('sow_documents')
      .update({
        status:      'signed',
        signed_at:   now,
        signed_by:   signerName,
        signer_email: client.email,
        signer_ip:   ip,
        client_signature_data: signatureData,
        updated_at:  now,
      })
      .eq('id', sow.id)
      .eq('status', 'awaiting_signature')
      .select('id')

    if (signUpdateErr) return NextResponse.json({ error: 'Failed to record signature' }, { status: 500 })
    if (!updatedSow || updatedSow.length === 0)
      return NextResponse.json({ error: 'This SOW was already signed' }, { status: 409 })

    // FIX (cron/portal audit round 3): everything below runs AFTER the signature has been durably recorded
    // (the compare-and-swap above is the commit point). It used to sit directly under the route's outer try,
    // so any throw from a later step — an email helper, the PDF render's follow-up writes, a lookup — returned
    // "Could not complete signing. Please try again." to a client whose signature HAD been recorded. Their
    // retry then hit 409 "already signed", and the agency/client confirmation emails, the PDF and the audit
    // entry that hadn't run yet were never produced. Post-commit failures are now caught here, logged, and the
    // client is told the truth (signed); api/cron/signing-integrity repairs whatever state was left behind.
    let clientToken = token
    let guardianEmail: string = project.guardian_email || ''
    try {

    // ── 1b. Reissue a long-lived token for post-signature access ─────
    // FIX (re-audit, portal section): the signing token carries a flat
    // 30-day expiry *from when the SOW was sent* (send-sow.ts), and this
    // route never reissued it on signature — so the "self-service
    // redownload" link handed to the client below (and /pdf, which checks
    // the same token) would go dead a fixed 30 days after send, regardless
    // of how close to that deadline the client actually signed. A SOW
    // signed on day 25 left the client 5 days to ever see their own
    // executed document again. Minting a fresh, long-lived token at the
    // moment of signature — same pattern the CO accept-counter flow
    // already uses correctly — decouples "how long do they have to sign"
    // from "how long can they keep the record of having signed."
    try {
      const jwtSecret = await getWorkspaceJwtSecret(service, sow.workspace_id)
      if (jwtSecret) {
        const secret = new TextEncoder().encode(jwtSecret)
        const newExpiresAt = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000) // 2 years
        const newToken = await new SignJWT({
          sowId: sow.id, workspaceId: sow.workspace_id, projectId: project.id,
          clientEmail: client.email, action: 'view',
        })
          .setProtectedHeader({ alg: 'HS256' })
          .setExpirationTime(newExpiresAt)
          .setJti(nanoid())
          .sign(secret)

        // FIX (cron/portal audit round 3): the result of this write was never read. On a failure the row kept the
        // OLD token while `clientToken` (the link emailed to the client) and the 'superseded' record below both
        // pointed at the NEW one — a confirmation email whose link resolves to nothing. Only switch over once
        // the write has actually landed; otherwise the original link stays in effect (it still resolves the
        // signed document), exactly as the catch below already intends.
        const { error: reissueErr } = await (service as any).from('sow_documents').update({
          token: newToken, expires_at: newExpiresAt.toISOString(),
        }).eq('id', sow.id)
        if (reissueErr) throw new Error(`token reissue write failed: ${reissueErr.message}`)
        clientToken = newToken

        // FIX (portal audit, section 18 — flagship finding): the ORIGINAL
        // signing-link email (sent at send-sow.ts time) is never patched
        // to point at the new token above — it can't be, it's already
        // delivered. Without this, a client who revisits that first email
        // after signing gets "this link is no longer active" instead of
        // their own executed document, because the token column no
        // longer matches what that email contains. Recording the OLD
        // token as superseded, with document_id, lets the GET/PDF routes
        // resolve it back to this SOW — same mechanism CO's accept flow
        // already relies on (see finalize-co.ts), which this SOW flow was
        // missing entirely. Non-fatal: on failure the client just falls
        // back to the same "invalid" experience that existed before this
        // fix, not a broken signing flow.
        const { error: supersedeErr } = await (service as any).from('revoked_tokens').insert({
          token, token_type: 'sow', reason: 'superseded', document_id: sow.id,
        })
        if (supersedeErr) console.error('SOW original-token supersede record failed (non-fatal):', supersedeErr.message)
      }
    } catch (e) { console.error('SOW post-signature token reissue failed (original link stays in effect):', e) }

    // ── 2. Update project → Active ───────────────────────────
    // FIX (re-audit, portal section): also clears stall_reason — if
    // sow-stall's cron had already flipped this project to
    // status='Stalled'/stall_reason='sow_unsigned' before the client got
    // around to signing, this update took it out of Stalled (via neq
    // above) but left stall_reason='sow_unsigned' sitting on an Active
    // project. Currently harmless (nothing reads stall_reason off a
    // non-Stalled project) but stale data waiting to confuse the next
    // feature that trusts it — and the manual PATCH path in
    // app/api/projects/[id]/route.ts already clears it on this exact
    // transition (BUG-046), so this brings the automated path to parity.
    // FIX (cron/portal audit round 3): the result was never read. If this write failed the SOW was already
    // 'signed' but the project sat at 'Awaiting Signature' forever — the retainer cron only bills Active
    // projects, and sow-stall stopped watching it because the SOW is no longer awaiting a signature. One retry
    // for a transient failure; if it still fails it is recorded, and api/cron/signing-integrity repairs it.
    let activateErr: { message: string } | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await (service as any).from('projects').update({
        status:        'Active',
        stall_reason:  null,
        updated_at:    now,
      }).eq('id', project.id).neq('status', 'Active')
      activateErr = error
      if (!error) break
    }
    if (activateErr) {
      console.error('SOW sign: could not activate the project:', activateErr.message)
      await logAudit(service, {
        workspaceId: sow.workspace_id, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
        eventType: 'sow.project_activation_failed', entityType: 'sow', entityId: sow.id,
        metadata: { project_id: project.id, error: activateErr.message },
      }).catch(() => {})
    }

    // ── 3. Guardian email ──────────────────────────────────────
    // Stable for the life of the project (see ensureGuardianEmail): it used to be rebuilt from THIS SOW's id on
    // every signature, so a later re-sign changed the address and mail the client had already been told to
    // forward to it was silently dropped.
    const guardian = await ensureGuardianEmail(service, project)
    guardianEmail = guardian.email
    if (guardian.error) {
      console.error('SOW sign: could not set guardian_email:', guardian.error)
      await logAudit(service, {
        workspaceId: sow.workspace_id, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
        eventType: 'sow.guardian_email_failed', entityType: 'sow', entityId: sow.id, metadata: { project_id: project.id, error: guardian.error },
      }).catch(() => {})
    }

    // ── 4. Create scope snapshot (spec §0.13) ────────────────────
    // Shared with the repair sweep — see writeScopeSnapshot for the deliverables-table / version-bump history.
    const snap = await writeScopeSnapshot(service, project.id, sow.sections || [], now)
    if (snap.error) {
      console.error('SOW sign: scope snapshot write failed:', snap.error)
      await logAudit(service, {
        workspaceId: sow.workspace_id, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
        eventType: 'sow.snapshot_failed', entityType: 'sow', entityId: sow.id,
        metadata: { project_id: project.id, error: snap.error },
      }).catch(() => {})
    }

    // ── 5. Mark firstSowSignedAt if null ─────────────────────
    if (!ws.first_sow_signed_at) {
      const { error: fsErr } = await (service as any).from('workspaces').update({
        first_sow_signed_at: now,
      }).eq('id', sow.workspace_id)
      if (fsErr) console.error('SOW sign: first_sow_signed_at update failed:', fsErr.message)
    }

    // ── 6. Create payment milestones from SOW metadata ────────
    await createSowMilestones(service, project.id, sow.id, sow.workspace_id, sow.metadata, project.contract_value, project.currency, sow.sections || [])

    // ── 6b. Fingerprint what was agreed ───────────────────────
    // SHA-256 over the exact content the client signed (sections incl. tables, metadata,
    // contract value, signer, and a digest of the signature image). Stored on the SOW and in
    // the audit trail so a later dispute can show the record was not altered after signing.
    const contentHash = computeContentHash({
      kind: 'sow', sowId: sow.id, version: sow.version, projectId: project.id,
      sections: sow.sections || [], metadata: sow.metadata || {},
      contractValue: project.contract_value, currency: project.currency,
      signedBy: signerName, signedAt: now, signerEmail: client.email,
      signatureSha256: createHash('sha256').update(signatureData).digest('hex'),
    })

    // ── 7. Audit log ──────────────────────────────────────────
    await logAudit(service, {
      // FIX (build, Reports & Audit re-pass): actor_id is `uuid REFERENCES
      // users(id)` — client.email is not a valid uuid, so this insert
      // failed silently (unchecked supabase-js error) and 'sow.signed' —
      // arguably the single most consequential event in this whole
      // app — never once reached audit_log. null is correct for a
      // non-platform-user actor; actorEmail/actorName already carry the
      // real identity.
      workspaceId: sow.workspace_id, actorId: null,
      actorEmail: client.email, actorName: signerName,
      eventType: 'sow.signed', entityType: 'sow',
      entityId: sow.id, entityName: project.name,
      metadata: { version: sow.version, signer_ip: ip, guardian_email: guardianEmail, content_hash: contentHash },
    })

    // ── 8. Render the executed PDF ONCE, freeze it, attach it to both emails ──
    // The rendered buffer is stored (private `pdfs` bucket) and served for every later download,
    // so the executed document can no longer drift when live rows change (agency signature,
    // addresses, retainer renewals rewriting contract_value, monthly retainer milestones).
    let pdfBuffer: Buffer | null = null
    let pdfAttachment: { filename: string; content: string } | undefined
    try {
      let logoUrl: string | null = null
      if (ws.logo_storage_path) {
        const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
        logoUrl = u?.publicUrl || null
      }
      const { data: milestones } = await (service as any)
        .from('payment_milestones')
        .select('title, amount, percentage, trigger, due_date, status')
        .eq('sow_id', sow.id)
        .order('due_date', { ascending: true, nullsFirst: false })
      pdfBuffer = await renderSowPdf({
        agencyName:    ws.agency_name,
        agencyLogoUrl: logoUrl,
        brandColour:   ws.brand_colour || '#1A5C3A',
        agencyAddress: ws.legal_address || null,
        agencyTaxId:   ws.tax_id || null,
        agencyPhone:   ws.phone || null,
        agencyWebsite: ws.website || null,
        clientName:    client.name,
        clientCompany: client.company_name || null,
        clientBillingAddress: client.billing_address || null,
        clientVatNumber:      client.vat_number || null,
        projectName:   project.name + (project.disc ? ` — ${project.disc}` : ''),
        contractValue: project.contract_value || 0,
        currency:      project.currency || 'USD',
        sections:      sow.sections || [],
        language:      sow.metadata?.language || 'en',
        msaReference:  sow.metadata?.msaReference || null,
        paymentSchedule: (milestones || []).map((m: any) => ({
          title: m.title, amount: m.amount, percentage: m.percentage,
          trigger: m.trigger, dueDate: m.due_date, status: m.status,
        })),
        signedBy:      signerName,
        signedAt:      now,
        agencySignatureData: ws.agency_signature_data || null,
        clientSignatureData: signatureData,
        version:       sow.version,
        // The emailed executed copy omitted the document number that every later download of the
        // same SOW carries.
        documentNumber: sow.document_number || null,
      })
      pdfAttachment = { filename: `SOW-${project.name.replace(/[^a-z0-9]/gi, '-')}.pdf`, content: pdfBuffer.toString('base64') }
    } catch (e) { console.error('SOW PDF generation failed (emails will send without attachment):', e) }

    // Freeze. Two separate updates so a deployment that hasn't applied migration 061 yet still
    // gets the stored PDF path (pdf_path is an original column; content_hash is new).
    if (pdfBuffer) {
      const storedPath = await storeExecutedPdf(service, { workspaceId: sow.workspace_id, kind: 'sow', id: sow.id, buffer: pdfBuffer })
      if (storedPath) {
        const { error: pathErr } = await (service as any).from('sow_documents').update({ pdf_path: storedPath }).eq('id', sow.id)
        if (pathErr) console.error('SOW sign: pdf_path update failed:', pathErr.message)
      }
    }
    const { error: hashErr } = await (service as any).from('sow_documents').update({ content_hash: contentHash }).eq('id', sow.id)
    if (hashErr) console.error('SOW sign: content_hash update failed (is migration 061 applied?):', hashErr.message)

    // ── 9. Notify SEND_SOW holders (Event 3) — awaited ───────
    const agencyEmails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW', 25, 'sow_signed', project.id).catch(() => [] as string[])
    if (agencyEmails.length) {
      await checkedSend(() => sendSowSignedAgencyEmail({
        to:          agencyEmails,
        agencyName:  ws.agency_name,
        clientName:  client.name,
        projectName: project.name + (project.disc ? ` — ${project.disc}` : ''),
        signedBy:    signerName,
        portalUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=sow`,
        attachments: pdfAttachment ? [pdfAttachment] : undefined,
      }), 'SOW signed (agency) email')
    }
    await notifyMembersWithPermission(service, {
      workspaceId: sow.workspace_id, permission: 'SEND_SOW', eventType: 'sow_signed',
      type: 'sow_signed', title: `SOW signed — ${project.name}`,
      body: `${signerName} signed the Statement of Work.`,
      entityType: 'project', entityId: project.id, projectId: project.id,
    })

    // ── 10. Confirm to client (Event 4) ───────────────────────
    // Portal links use NEXT_PUBLIC_PORTAL_URL || NEXT_PUBLIC_APP_URL everywhere else.
    const portalBase = process.env.NEXT_PUBLIC_PORTAL_URL || process.env.NEXT_PUBLIC_APP_URL
    const confirmCc = await withPrimaryContactCc(service, project.client_id, client.email, client.cc_emails)
    const replyTo = await resolveReplyTo(service, sow.workspace_id, null)
    await checkedSend(() => sendSowSignedClientEmail({
      replyTo,
      to:          client.email,
      cc:          confirmCc,
      clientName:  client.name,
      agencyName:  ws.agency_name,
      projectName: project.name,
      portalUrl:   `${portalBase}/portal/sow/${clientToken}`,
      attachments: pdfAttachment ? [pdfAttachment] : undefined,
    }), 'SOW signed (client) email')

    } catch (postErr) {
      console.error('SOW sign: post-signature step failed after the signature was recorded:', postErr)
      await logAudit(service, {
        workspaceId: sow.workspace_id, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
        eventType: 'sow.post_signing_failed', entityType: 'sow', entityId: sow.id,
        metadata: { project_id: project.id, error: postErr instanceof Error ? postErr.message : String(postErr) },
      }).catch(() => {})
    }

    return NextResponse.json({ ok: true, guardianEmail, token: clientToken })
  } catch (err) {
    console.error('SOW sign error:', err)
    return NextResponse.json({ error: 'Could not complete signing. Please try again.' }, { status: 500 })
  }
}
