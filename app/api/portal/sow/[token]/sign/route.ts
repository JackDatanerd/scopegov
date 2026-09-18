export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { SignJWT } from 'jose'
import { nanoid } from 'nanoid'
import { logAudit } from '@/lib/utils/audit'
import { sendSowSignedAgencyEmail, sendSowSignedClientEmail } from '@/lib/email/templates'
import { parseTableAmount } from '@/lib/sow/table-schema'
import { roundCurrency } from '@/lib/utils/format'
import { renderSowPdf } from '@/lib/pdf/renderer'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { getWorkspaceJwtSecret, isWorkspaceDeleted } from '@/lib/utils/workspace-secret'
import { checkRevokedToken, verifySowJwt } from '../_shared'
import { checkPortalRateLimit, recordPortalAction } from '@/lib/utils/portal-rate-limit'
import { getClientIp } from '@/lib/utils/request-ip'

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

    const { signerName, signatureData } = await request.json()
    const ip             = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'

    if (!signerName || signerName.trim().length < 3)
      return NextResponse.json({ error: 'Full name required to sign' }, { status: 400 })
    if (!signatureData || typeof signatureData !== 'string' || !signatureData.startsWith('data:image/'))
      return NextResponse.json({ error: 'Please draw your signature to sign' }, { status: 400 })
    // FIX (audit round 3): same missing size cap as the CO accept route —
    // see that file for the full note.
    if (signatureData.length > 500_000)
      return NextResponse.json({ error: 'Signature data is too large' }, { status: 400 })

    // Check revoked
    const { revoked } = await checkRevokedToken(service, token)
    if (revoked) return NextResponse.json({ error: 'This link is no longer active' }, { status: 410 })

    // Fetch SOW
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, status, sections, metadata, expires_at, project_id, workspace_id,
        projects(id, name, disc, currency, contract_value, client_id, created_by,
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
        signed_by:   signerName.trim(),
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
    let clientToken = token
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

        await (service as any).from('sow_documents').update({
          token: newToken, expires_at: newExpiresAt.toISOString(),
        }).eq('id', sow.id)
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
        try {
          await (service as any).from('revoked_tokens').insert({
            token, token_type: 'sow', reason: 'superseded', document_id: sow.id,
          })
        } catch (e) { console.error('SOW original-token supersede record failed (non-fatal):', e) }
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
    await (service as any).from('projects').update({
      status:        'Active',
      stall_reason:  null,
      updated_at:    now,
    }).eq('id', project.id).neq('status', 'Active')

    // ── 3. Set guardian email ─────────────────────────────────
    // Format: proj-{8chars of sowId}@guard.scopegov.app (carry-forward §2.4)
    const guardianDomain = process.env.NEXT_PUBLIC_GUARDIAN_EMAIL_DOMAIN || 'guard.scopegov.app'
    const guardianEmail  = `proj-${sow.id.replace(/-/g,'').slice(0,8)}@${guardianDomain}`
    await (service as any).from('projects').update({ guardian_email: guardianEmail }).eq('id', project.id)

    // ── 4. Create scope snapshot (spec §0.13 — in same transaction) ─
    // FIX (re-audit): the 'deliverables' section moved from prose `content`
    // to a structured `table` (lib/sow/table-schema.ts) in the doc-quality
    // refactor, but this extraction never followed — it was reading a field
    // that's now always ''. Every SOW signed since then wrote an EMPTY
    // deliverables array into project_scope_snapshot, which Guardian's
    // scope-creep classifier and CO drafting both rely on as the agreed
    // baseline. Read the table first; fall back to the old HTML extraction
    // only for pre-refactor SOWs that may still carry prose content with no
    // table rows.
    const sections = sow.sections || []
    const deliverablesSection = sections.find((s: any) => s.id === 'deliverables')
    const deliverables = (deliverablesSection?.table || []).length > 0
      ? (deliverablesSection.table as Array<Record<string, string>>)
          .map(row => ({ title: (row.deliverable || '').trim() }))
          .filter(d => d.title)
      : extractDeliverables(deliverablesSection?.content || '')
    const outOfScope = extractDeliverables(sections.find((s: any) => s.id === 'oos')?.content || '')

    // FIX (deep audit, section 13 — cross-cutting): select version too and
    // advance it on update — see migration 045's note. This snapshot write
    // (a re-signed SOW replacing the prior scope) previously left `version`
    // untouched, which is exactly what let app/api/guardian/scope-adjustment
    // route.ts's compare-and-swap miss a re-sign landing between its read
    // and its write: version matched the stale value it read, the write
    // "succeeded", and it silently clobbered the just-re-signed scope.
    const { data: existingSnap } = await (service as any)
      .from('project_scope_snapshot').select('id,version').eq('project_id', project.id).single()

    if (existingSnap) {
      await (service as any).from('project_scope_snapshot').update({
        deliverables, out_of_scope: outOfScope,
        last_updated_at: now, last_updated_by: 'signing',
        version: (existingSnap.version || 1) + 1,
      }).eq('project_id', project.id)
    } else {
      await (service as any).from('project_scope_snapshot').insert({
        project_id:      project.id,
        deliverables,
        out_of_scope:    outOfScope,
        last_updated_at: now,
        last_updated_by: 'signing',
      })
    }

    // ── 5. Mark firstSowSignedAt if null ─────────────────────
    if (!ws.first_sow_signed_at) {
      await (service as any).from('workspaces').update({
        first_sow_signed_at: now,
      }).eq('id', sow.workspace_id)
    }

    // ── 6. Create payment milestones from SOW metadata ────────
    await createMilestones(service, project.id, sow.id, sow.workspace_id, sow.metadata, project.contract_value, project.currency, sow.sections || [])

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
      actorEmail: client.email, actorName: signerName.trim(),
      eventType: 'sow.signed', entityType: 'sow',
      entityId: sow.id, entityName: project.name,
      metadata: { version: sow.version, signer_ip: ip, guardian_email: guardianEmail },
    })

    // ── 8. Build the signed PDF once, attach to both confirmation emails ──
    // FIX: both email templates already claimed "A PDF copy is attached"
    // in their copy — nothing ever actually generated or attached one.
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
      const pdfBuffer = await renderSowPdf({
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
        // FIX (section-9 audit, 9-G7 / 9-G4): drafting language (so
        // schema-driven table headers localize) and the MSA
        // cross-reference, which SowPdfData has declared and rendered all
        // along while no route ever passed it.
        language:      sow.metadata?.language || 'en',
        msaReference:  sow.metadata?.msaReference || null,
        paymentSchedule: (milestones || []).map((m: any) => ({
          title: m.title, amount: m.amount, percentage: m.percentage,
          trigger: m.trigger, dueDate: m.due_date, status: m.status,
        })),
        signedBy:      signerName.trim(),
        signedAt:      now,
        agencySignatureData: ws.agency_signature_data || null,
        clientSignatureData: signatureData,
        version:       sow.version,
      })
      pdfAttachment = { filename: `SOW-${project.name.replace(/[^a-z0-9]/gi, '-')}.pdf`, content: pdfBuffer.toString('base64') }
    } catch (e) { console.error('SOW PDF generation for email failed (emails will send without attachment):', e) }

    // ── 9. Notify SEND_SOW holders (Event 3) — awaited ───────
    try {
      const agencyEmails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW', 25, 'sow_signed', project.id)
      if (agencyEmails.length) {
        await sendSowSignedAgencyEmail({
          to:          agencyEmails,
          agencyName:  ws.agency_name,
          clientName:  client.name,
          projectName: project.name + (project.disc ? ` — ${project.disc}` : ''),
          signedBy:    signerName.trim(),
          portalUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=sow`,
          attachments: pdfAttachment ? [pdfAttachment] : undefined,
        })
      }
    } catch (e) { console.error('Agency signed email failed:', e) }
    await notifyMembersWithPermission(service, {
      workspaceId: sow.workspace_id, permission: 'SEND_SOW', eventType: 'sow_signed',
      type: 'sow_signed', title: `SOW signed — ${project.name}`,
      body: `${signerName.trim()} signed the Statement of Work.`,
      entityType: 'project', entityId: project.id, projectId: project.id,
    })

    // ── 10. Confirm to client (Event 4) ───────────────────────
    try {
      await sendSowSignedClientEmail({
        to:          client.email,
        cc:          client.cc_emails || [],
        clientName:  client.name,
        agencyName:  ws.agency_name,
        projectName: project.name,
        portalUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/portal/sow/${clientToken}`,
        attachments: pdfAttachment ? [pdfAttachment] : undefined,
      })
    } catch (e) { console.error('Client confirm email failed:', e) }

    return NextResponse.json({ ok: true, guardianEmail, token: clientToken })
  } catch (err) {
    console.error('SOW sign error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

function extractDeliverables(html: string): Array<{ title: string }> {
  if (!html) return []
  // Extract list items from HTML
  const items: Array<{ title: string }> = []
  const liRegex = /<li[^>]*>(.*?)<\/li>/gi
  let match
  while ((match = liRegex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').trim()
    if (text) items.push({ title: text })
  }
  // Fallback: extract paragraphs
  if (!items.length) {
    const pRegex = /<p[^>]*>(.*?)<\/p>/gi
    while ((match = pRegex.exec(html)) !== null) {
      const text = match[1].replace(/<[^>]+>/g, '').trim()
      if (text && text.length > 3) items.push({ title: text })
    }
  }
  return items.slice(0, 50)
}

// FIX (re-audit): this used to (a) insert milestones one at a time in a
// loop, so a failure partway through a multi-milestone structure (e.g. the
// 50/50 split) could leave only the first milestone on file with no
// indication anything was wrong, and (b) swallow any failure into
// console.error only — the SOW still ends up 'signed' with NO payment
// milestones at all, silently blocking invoicing for the project with
// nothing operator-visible. Insert as a single batch (one INSERT statement
// is atomic — either all rows land or none do, no partial split) and log
// an audit entry on failure so it's at least discoverable, rather than a
// server log line nobody will see.
async function createMilestones(
  service: any, projectId: string, sowId: string, workspaceId: string,
  metadata: any, contractValue: number, currency: string, sections: any[]
) {
  try {
    const structure = metadata?.paymentStructure || '50_50'
    const milestones = []

    if (structure === '50_50') {
      // FIX (bug — payment split not summing to contract value): rounding
      // each half independently (roundCurrency(cv * 0.5) applied to both)
      // can produce two halves that don't sum back to the contract value
      // when the total has an odd cent — e.g. $1599.97 * 0.5 = $799.985,
      // which rounds to $799.99 on both sides, summing to $1599.98, a
      // cent more than the contract. Round the first share, then set the
      // second to whatever's left — guarantees an exact sum every time,
      // with any leftover cent absorbed by the final milestone. Standard
      // practice for splitting a currency total across N shares.
      const upfront = roundCurrency(contractValue * 0.5)
      const final   = roundCurrency(contractValue - upfront)
      milestones.push(
        { title: 'Upfront payment (50%)',   amount: upfront, trigger: 'Project kick-off',       type: 'percentage', percentage: 50 },
        { title: 'Final payment (50%)',      amount: final,   trigger: 'Final delivery approval', type: 'percentage', percentage: 50 },
      )
    } else if (structure === '100_upfront') {
      milestones.push({ title: 'Full payment', amount: roundCurrency(contractValue), trigger: 'Before work commences', type: 'fixed', percentage: null })
    } else if (structure === 'on_delivery') {
      milestones.push({ title: 'Full payment', amount: roundCurrency(contractValue), trigger: 'Final delivery approval', type: 'fixed', percentage: null })
    } else if (structure === 'monthly') {
      // FIX (section-9 re-pass): this created the milestone with no
      // due_date. app/api/cron/retainer-milestones de-dupes each month's
      // row strictly by matching due_date to the 1st of the target
      // month, so a NULL due_date here could never match — the cron's
      // first run after signing couldn't tell this row apart from "no
      // milestone yet for this month" and inserted a second full-amount
      // "Monthly retainer" row for the same month. Setting due_date to
      // the 1st of the signing month gives the cron the same key it
      // computes for itself, closing that gap.
      const signedOn = new Date()
      const firstOfSigningMonth = `${signedOn.getFullYear()}-${String(signedOn.getMonth() + 1).padStart(2, '0')}-01`
      milestones.push({ title: 'Monthly retainer', amount: roundCurrency(contractValue), trigger: 'Monthly — first of month', type: 'retainer_monthly', percentage: null, dueDate: firstOfSigningMonth })
    } else if (structure === 'milestones') {
      // FIX (section-9 audit, real bug — now genuinely fixed): 'milestones'
      // is a selectable payment structure (the SOW boilerplate literally
      // prints "Payable in milestones as defined below") but there was
      // never any table/UI for an agency to actually define what those
      // milestones are — deliverables/timeline/roles all had dedicated
      // table sections, payment schedule never did. This branch used to
      // fall into the generic `else` below and silently create ONE
      // "Project payment" milestone for the FULL contract value,
      // contradicting the SOW's own printed text.
      //
      // FEATURE (built): lib/sow/table-schema.ts now defines a real
      // payment_schedule table section, same architecture as deliverables/
      // timeline/roles — the agency itemizes it in SowEditor, AI
      // generation proposes a starting split (with amounts always
      // server-computed, never AI money-math — see
      // app/api/sow/generate/route.ts), and this reads those rows
      // directly instead of guessing. The send route (see send/route.ts)
      // now validates this foots to the contract value BEFORE the SOW
      // ever reaches the client, so this sign-time check is a backstop,
      // not the primary safety net — it should only ever trip if that
      // send-time validation was somehow bypassed.
      const scheduleSection = (sections || []).find((s: any) => s.id === 'payment_schedule')
      const rows: any[] = Array.isArray(scheduleSection?.table) ? scheduleSection.table : []
      const parsedRows = rows
        .map((r: any) => ({
          title: String(r?.milestone || '').trim(),
          // FIX (section-9 audit, 9-G6): bare Number() on a free-text
          // cell makes "1,500" NaN, which dropped the row and silently
          // collapsed the whole negotiated schedule to a single lump-sum
          // milestone. Same parser the send-time validation uses.
          amount: parseTableAmount(r?.amount) ?? 0,
          trigger: String(r?.trigger || '').trim(),
        }))
        .filter(r => r.title && r.amount > 0)
      const scheduleSum = parsedRows.reduce((s, r) => s + r.amount, 0)

      if (parsedRows.length > 0 && Math.abs(scheduleSum - contractValue) < 0.01) {
        for (const r of parsedRows) {
          milestones.push({
            title:   r.title.slice(0, 200),
            amount:  roundCurrency(r.amount),
            trigger: (r.trigger || 'As defined in the SOW').slice(0, 500),
            type: 'fixed', percentage: null,
          })
        }
      } else {
        // Genuinely defensive at this point (send-time validation should
        // have already blocked this) — an honest fallback rather than a
        // silent one, and flagged in the audit log so it's discoverable
        // if it ever does happen (e.g. a future edit path that bypasses
        // the send-time check).
        //
        // FIX (build, Reports & Audit re-pass): this and the two other
        // logAudit calls in this function were `actorId: ''` — an empty
        // string is just as invalid a uuid as the literal 'system' string
        // this codebase already fixed everywhere else (see
        // lib/utils/audit.ts). The insert failed silently (supabase-js
        // doesn't throw on a DB error, and it was never checked here), so
        // these two "make sure this is discoverable if it ever happens"
        // events were, in fact, never discoverable. null is the correct
        // value.
        milestones.push({
          title: 'Project payment', amount: roundCurrency(contractValue),
          trigger: 'Full contract value — no itemized milestone schedule was defined in this SOW',
          type: 'fixed', percentage: null,
        })
        await logAudit(service, {
          workspaceId, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
          eventType: 'sow.milestone_schedule_undefined', entityType: 'sow', entityId: sowId,
          metadata: { project_id: projectId, contract_value: contractValue, rows_found: rows.length, rows_valid: parsedRows.length, schedule_sum: scheduleSum },
        }).catch(() => {})
      }
    } else {
      milestones.push({ title: 'Project payment', amount: roundCurrency(contractValue), trigger: 'As per agreement', type: 'fixed', percentage: null })
    }

    const { error: insertErr } = await (service as any).from('payment_milestones').insert(
      milestones.map(m => ({
        project_id:   projectId,
        sow_id:       sowId,
        title:        m.title,
        type:         m.type,
        amount:       m.amount,
        percentage:   m.percentage,
        trigger:      m.trigger,
        due_date:     (m as any).dueDate ?? null,
        tax_rate:     0,
        tax_inclusive: false,
        status:       'pending',
      }))
    )

    if (insertErr) {
      console.error('Milestone creation failed:', insertErr)
      await logAudit(service, {
        workspaceId, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
        eventType: 'sow.milestones_creation_failed', entityType: 'sow', entityId: sowId,
        metadata: { project_id: projectId, error: insertErr.message || String(insertErr) },
      }).catch(() => {})
    }
  } catch (e) {
    console.error('Milestone creation failed:', e)
    await logAudit(service, {
      workspaceId, actorId: null, actorEmail: 'system@scopegov.app', actorName: 'ScopeGov',
      eventType: 'sow.milestones_creation_failed', entityType: 'sow', entityId: sowId,
      metadata: { project_id: projectId, error: e instanceof Error ? e.message : String(e) },
    }).catch(() => {})
  }
}
