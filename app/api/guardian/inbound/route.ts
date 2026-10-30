export const runtime = 'nodejs'
// FIX (Guardian section 13, pass 14 - B4): embedding + classification (each bounded to 25s with one retry, see lib/ai/guardian.ts)
// need more room than a short platform default; the sibling AI routes (sow/generate, co/draft) already set one.
export const maxDuration = 120

import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { toPlainText, MAX_CHECK_CONTENT_CHARS, type Sensitivity } from '@/lib/ai/guardian'
import { classifyAndRecord, findDuplicateCheck, tryEmbedding, GUARDIAN_SYSTEM_ACTOR } from '@/lib/ai/guardian-pipeline'
import {
  extractUnquotedContent, isForwardSubject, cleanSubject, isAutomatedMessage, senderEmail, matchGuardianAddress,
} from '@/lib/ai/guardian-email'
import { logAudit } from '@/lib/utils/audit'
import { stripUnstorableText, truncateText } from '@/lib/utils/sanitize'
import { claimAiRateSlotByProject } from '@/lib/utils/rate-limit'
import { isWorkspaceLapsed } from '@/lib/billing/plans'
import { EVIDENCE_BUCKET } from '@/lib/utils/storage-cleanup'
import { ALLOWED_ATTACHMENT_TYPES, matchesDeclaredType, resolveAttachmentType } from '@/lib/utils/file-signature'
import { sameEmail } from '@/lib/utils/escape-like'
import {
  parseReceivedEvent, recipientHeader, verifyInboundSignature, fetchReceivedEmail, listReceivedAttachments,
  downloadReceivedAttachment, toSenderView, senderFailedAuthentication, InboundFetchError,
  type InboundAttachmentFile,
} from '@/lib/email/resend-inbound'

// Guardian inbound email, delivered by Resend ("Receiving").
//
// Resend POSTs a small Svix-signed `email.received` event (ids, addresses, subject - no body). The body, headers and
// attachments are then fetched from the Resend API (lib/email/resend-inbound.ts). Any failure to fetch answers 500 so
// Resend redelivers; nothing is stored until the fetch has succeeded, so a redelivery is always safe.
//
// Auth: the Svix signature (HMAC over id.timestamp.body, 5-minute replay window) with RESEND_INBOUND_WEBHOOK_SECRET -
// a per-endpoint secret distinct from RESEND_WEBHOOK_SECRET (the outbound delivery webhook). Missing secret = 503, bad
// signature = 401.
//
// Replaces the Postmark inbound webhook (HTTP Basic Auth in the URL; attachments base64-inlined in the JSON, which
// Vercel's 4.5 MB request cap made unreceivable above ~3 MB). See README section 4.
// A Resend event older than this with a 404 on fetch is treated as expired (Resend keeps received mail 30 days).
const EXPIRED_AFTER_MS = 60 * 60 * 1000

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text()
    const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET
    if (!secret) {
      console.error('Guardian inbound: RESEND_INBOUND_WEBHOOK_SECRET is not set')
      return NextResponse.json({ error: 'Inbound webhook not configured' }, { status: 503 })
    }
    if (!verifyInboundSignature(rawBody, request.headers, secret)) {
      console.warn('Guardian inbound: signature check failed')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let event: any
    try { event = JSON.parse(rawBody) }
    catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
    const ev = parseReceivedEvent(event)
    if (!ev) return NextResponse.json({ ok: true, message: 'Not an email.received event — ignored' })

    // FIX (independent pass, section 13 - B1): these header-derived strings go into source_metadata (jsonb), the flag's audit
    // metadata and the retry path, but were the only inbound text not scrubbed. A NUL (or half an emoji) in a
    // Subject/From - trivial to craft with a MIME encoded-word - made the check insert fail, the route answered 500
    // and the provider redelivered it forever: the email was never stored or checked. Scrub and cap them like the body.
    // Resend's own email id is the idempotency key: it is identical on every redelivery of the same event.
    const toEmail    = truncateText(stripUnstorableText(recipientHeader(ev)), 500)
    const subject    = truncateText(stripUnstorableText(ev.subject), 1000)
    const messageId  = truncateText(stripUnstorableText(ev.emailId), 200)

    // Extract the project from the guardian address (proj-{8chars}@guard.scopegov.app).
    // matchGuardianAddress anchors the whole address (the old regex also matched
    // "evilproj-abc@…" and "proj-abc@guard.scopegov.app.evil.com").
    const guardianDomain = process.env.NEXT_PUBLIC_GUARDIAN_EMAIL_DOMAIN || 'guard.scopegov.app'
    const guardianPrefix = matchGuardianAddress(toEmail, guardianDomain)
    if (!guardianPrefix) {
      return NextResponse.json({ ok: true, message: 'Not a Guardian address — ignored' })
    }

    const service = createServiceClient()

    const { data: projects, error: projectErr } = await (service as any)
      .from('projects')
      .select(`id, name, status, stall_reason, workspace_id, client_id,
        workspaces(id, agency_name, guardian_sensitivity_tier, deleted_at, plan_tier, trial_ends_at, lapsed_at),
        project_scope_snapshot(deliverables, out_of_scope, last_updated_at)`)
      .ilike('guardian_email', `proj-${guardianPrefix}@%`)
      .is('deleted_at', null) // soft-deleted project: same as "no such project"
      .limit(1)
    const project = projects?.[0]

    if (!project) {
      // A read error must be retried by Resend (500), not swallowed as "no such project".
      if (projectErr) {
        console.error('Guardian inbound: project fetch failed', projectErr)
        return NextResponse.json({ error: 'Internal error' }, { status: 500 })
      }
      console.warn(`No project found for guardian email prefix: ${guardianPrefix}`)
      return NextResponse.json({ ok: true, message: 'No matching project' })
    }

    // A suspended / deleted workspace is gone everywhere else (session, portal, the stall crons) —
    // its project address must not keep spending AI, raising flags and emailing the team. Fail
    // closed if the workspace row didn't come back. 200 so Resend doesn't redeliver.
    if (!project.workspaces || project.workspaces.deleted_at)
      return NextResponse.json({ ok: true, message: 'Workspace inactive — message not processed' })

    // Archived / Complete projects accept no new checks. (There is deliberately NO auto-reply:
    // inbound never sends one, and replying to an unauthenticated sender's
    // address is a backscatter vector. A past comment claiming the provider handles it was wrong.)
    if (['Archived', 'Complete'].includes(project.status)) {
      return NextResponse.json({ ok: true, message: 'Project inactive — message not processed' })
    }

    // Idempotency: Resend re-delivers on any non-2xx (and after our own 500s). Without this a
    // redelivery re-ran the whole paid pipeline.
    if (messageId) {
      const { data: seen } = await (service as any).from('guardian_checks')
        .select('id').eq('project_id', project.id).eq('source_metadata->>message_id', messageId).limit(1)
      if (seen?.length) return NextResponse.json({ ok: true, message: 'Already processed', checkId: seen[0].id })
    }

    // FIX (Projects & Dashboard independent pass): the project's Pause confirmation promises "Guardian
    // monitoring stops while it's paused", but only Archived/Complete were skipped here — a manually
    // paused project kept raising flags and notifying the team from forwarded emails. A manual pause
    // is a deliberate "stop watching this"; honour it. (A pause that came from the SOW-unsigned stall
    // is not a decision by anyone, so it is unchanged. Manual "Check content" from the Guardian tab
    // still works while paused.)
    if (project.status === 'Stalled' && project.stall_reason === 'manual') {
      return NextResponse.json({ ok: true, message: 'Project paused — email not checked' })
    }

    // ── Fetch the message (body, headers, attachments) from Resend ──
    // Done after every cheap DB filter above, so a redelivery, an unknown address or a paused project costs no API call.
    // Any failure throws -> 500 -> Resend redelivers, before anything has been stored. A 404 on an event more than an
    // hour old means the message has expired on Resend's side: nothing a retry can fix, so acknowledge it.
    let received: Awaited<ReturnType<typeof fetchReceivedEmail>>
    let attachmentFiles: InboundAttachmentFile[] = []
    try {
      received = await fetchReceivedEmail(ev.emailId)
      if (received.attachmentCount > 0) attachmentFiles = (await listReceivedAttachments(ev.emailId)).slice(0, 10)
    } catch (e) {
      const expired = e instanceof InboundFetchError && e.status === 404 && ev.eventAtMs !== null && Date.now() - ev.eventAtMs > EXPIRED_AFTER_MS
      if (!expired) throw e
      console.warn(`Guardian inbound: message ${ev.emailId} no longer available on Resend — acknowledged`)
      return NextResponse.json({ ok: true, message: 'Message no longer available' })
    }
    const sender = toSenderView(ev, received)

    // Bounces / out-of-office / list mail would otherwise cost two AI calls each and raise junk flags.
    if (isAutomatedMessage(sender)) {
      return NextResponse.json({ ok: true, message: 'Automated message — skipped' })
    }

    const fromEmail  = truncateText(stripUnstorableText(String(sender.From || '')), 500)
    const fromAddr   = truncateText(stripUnstorableText(senderEmail(sender)), 320)

    // ── Build the text to classify ────────────────────────────
    // Resend has no reply-stripping field, so our own extractUnquotedContent does all of it. The SUBJECT is part of the
    // request ("Request: add a Spanish version") and used to be dropped entirely.
    const isForward = isForwardSubject(subject)
    const fullText  = received.text ? toPlainText(received.text) : toPlainText(received.html)
    const bodyText  = extractUnquotedContent(fullText, { isForward })
    const subj      = cleanSubject(subject)
    let cleanContent = [subj ? `Subject: ${subj}` : '', bodyText].filter(Boolean).join('\n\n').trim()
    if (cleanContent.length > MAX_CHECK_CONTENT_CHARS) cleanContent = truncateText(cleanContent, MAX_CHECK_CONTENT_CHARS)

    // The old floor was 20 characters, which discarded real requests like "Add dark mode".
    if (cleanContent.length < 8 || (!bodyText && !subj)) {
      return NextResponse.json({ ok: true, message: 'Only quoted reply — skipped' })
    }

    const sensitivity = (project.workspaces?.guardian_sensitivity_tier || 'medium') as Sensitivity
    const snapshot    = project.project_scope_snapshot // one-to-one → object

    // ── Sender recognition (informational — never blocks) ─────
    // A sender that fails DMARC (verified by Resend's receiving server, not the sender's own headers) is not "known"
    // even when the From address matches the client: that is exactly what a spoofed From looks like.
    const spoofed     = senderFailedAuthentication(received.authentication)
    const senderKnown = !spoofed && await isKnownSender(service, project.workspace_id, project.client_id, fromAddr)
    const attachments = attachmentFiles.map(a => truncateText(stripUnstorableText(a.filename), 120)).filter(Boolean)
    const sourceMetadata: Record<string, unknown> = {
      from: fromEmail, from_address: fromAddr, subject, to: toEmail,
      message_id: messageId,
      ...(received.rfcMessageId ? { rfc_message_id: truncateText(stripUnstorableText(received.rfcMessageId), 300) } : {}),
      ...(received.authentication ? { authentication: received.authentication } : {}),
      sender_known: senderKnown,
      ...(attachments.length ? { attachments } : {}),
    }

    const baseRow = {
      project_id: project.id, workspace_id: project.workspace_id, content: cleanContent,
      source: 'email', submitted_by: null, submitted_at: new Date().toISOString(),
    }
    const insertCheck = async (extra: Record<string, unknown>) => {
      const { data, error } = await (service as any).from('guardian_checks')
        .insert({ ...baseRow, ...extra }).select('id').single()
      if (error) {
        // Unique (project, message_id) violation = a concurrent delivery of the same email won the race.
        if ((error as any).code === '23505') return { id: null as string | null, raced: true }
        throw new Error(`Could not store check: ${error.message}`) // → 500 → Resend redelivers (was: silent 200 = email lost)
      }
      return { id: data.id as string, raced: false }
    }

    // FEATURE (independent pass round 2, section 13 — feature gap): the attachment files themselves are kept (not just their
    // names). Best-effort: a bad/oversized/unrecognised attachment is skipped and logged, never turns a stored,
    // otherwise-successful check into a 500 (which would make Resend redeliver the whole email, and the redelivery
    // returns "Already processed" so the file could not be recovered that way anyway).
    // Same private bucket + magic-byte validation the manual flag/exception evidence upload uses
    // (lib/utils/file-signature.ts) — this is the same kind of file, just arriving by a different
    // door. Saved regardless of which branch below stores the row (queued-pending / rate-limited /
    // classified) — the client's evidence matters even for a check that isn't classified yet.
    // Attachments are downloaded from Resend's signed URLs by this function, so they never ride in the webhook request:
    // the old ~3 MB ceiling (Vercel's 4.5 MB body cap on base64-in-JSON) is gone and these limits are the real ones.
    // The size is known from the listing before any bytes are fetched.
    const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
    const MAX_TOTAL_ATTACHMENT_BYTES = 30 * 1024 * 1024 // per email: bounds time and memory inside maxDuration
    const saveCheckAttachments = async (checkId: string) => {
      let total = 0
      for (const a of attachmentFiles) {
        try {
          const name = truncateText(stripUnstorableText(a.filename), 200) || 'attachment'
          // FIX (independent pass 5, section 13 - L1): some mail clients label a PDF / .docx / .eml
          // application/octet-stream (or send no type). The manual upload route resolves those from the extension;
          // this path took the declared type verbatim, so the file was silently dropped. Same resolver, and binary
          // types still have to pass the magic-byte check below.
          const contentType = resolveAttachmentType(name, String(a.contentType || '').split(';')[0].trim().toLowerCase())
          if (!ALLOWED_ATTACHMENT_TYPES.has(contentType)) continue
          if (a.size > MAX_ATTACHMENT_BYTES || total + a.size > MAX_TOTAL_ATTACHMENT_BYTES) continue
          const buffer = await downloadReceivedAttachment(a, MAX_ATTACHMENT_BYTES)
          if (!buffer || buffer.length === 0) continue
          if (total + buffer.length > MAX_TOTAL_ATTACHMENT_BYTES) continue
          if (!matchesDeclaredType(contentType, buffer)) continue
          total += buffer.length
          const rawExt = name.includes('.') ? (name.split('.').pop() || '') : ''
          const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin'
          const storagePath = `${project.workspace_id}/guardian_check/${checkId}/${crypto.randomUUID()}.${ext}`
          const { error: upErr } = await service.storage.from(EVIDENCE_BUCKET)
            .upload(storagePath, buffer, { contentType, upsert: false })
          if (upErr) { console.error('Guardian inbound: attachment upload failed:', upErr.message); continue }
          const { error: insErr } = await (service as any).from('guardian_check_attachments').insert({
            workspace_id: project.workspace_id, project_id: project.id, check_id: checkId,
            file_name: name, file_size: buffer.length, mime_type: contentType, storage_path: storagePath,
          })
          if (insErr) {
            console.error('Guardian inbound: attachment row insert failed:', insErr.message)
            await service.storage.from(EVIDENCE_BUCKET).remove([storagePath])
          }
        } catch (e) {
          console.error('Guardian inbound: attachment save failed:', e)
        }
      }
    }

    // FIX (independent pass, section 13): the two "keep the mail, classify later" branches below (no signed SOW /
    // rate-limited) stored EVERY email — content up to 20k chars plus up to 10 MB per attachment — with no bound.
    // The project address is unauthenticated (sender recognition is informational, by design), so anyone who knows
    // or guesses it could grow the table and the evidence bucket without limit once the rate limit tripped. Cap the
    // unclassified backlog per project; past the cap the mail is dropped with a 200 (a 5xx would only make Resend
    // redeliver the flood) and logged. Legitimate volume never comes near it: the sweep drains the queue.
    const MAX_QUEUED_PER_PROJECT = 200
    const queueFull = async (): Promise<boolean> => {
      const { count, error } = await (service as any).from('guardian_checks')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', project.id).eq('source', 'email').eq('outcome', 'pending').eq('is_duplicate', false)
      if (error) return false // fail open — better to keep a mail than to drop one on a count error
      return (count || 0) >= MAX_QUEUED_PER_PROJECT
    }

    // ── No signed SOW yet: keep the mail, spend nothing ───────
    // Re-classified automatically by the guardian-health sweep after the SOW is signed.
    // A lapsed (read-only) workspace has no paid plan: the mail is kept (nothing is lost if they resubscribe) but spends no AI,
    // raises no flag and emails nobody. The guardian-health sweep skips lapsed workspaces and picks the backlog up afterwards.
    const lapsed = isWorkspaceLapsed(project.workspaces.plan_tier, project.workspaces.trial_ends_at, project.workspaces.lapsed_at)
    if (!snapshot || lapsed) {
      if (await queueFull()) {
        console.warn(`Guardian inbound backlog full for project ${project.id} — email dropped`)
        return NextResponse.json({ ok: true, outcome: 'dropped', reason: 'backlog_full' })
      }
      const r = await insertCheck({ source_metadata: sourceMetadata, is_duplicate: false, outcome: 'pending' })
      if (r.id) await saveCheckAttachments(r.id)
      return NextResponse.json({ ok: true, outcome: 'pending', checkId: r.id, ...(lapsed ? { reason: 'workspace_lapsed' } : {}) })
    }

    // ── Rate limit: KEEP the email (previously dropped with a 200 → lost forever) ──
    // FIX (independent pass 10, section 13 - B2): claimed atomically (see claimAiRateSlotByProject) instead of check -> paid call -> record.
    const limited = await claimAiRateSlotByProject(service, project.workspace_id, project.id, 'guardian.inbound')
    if (!limited.allowed) {
      console.warn(`Guardian inbound rate limit hit for project ${project.id} — queued for sweep`)
      if (await queueFull()) {
        console.warn(`Guardian inbound backlog full for project ${project.id} — email dropped`)
        return NextResponse.json({ ok: true, outcome: 'dropped', reason: 'backlog_full' })
      }
      const r = await insertCheck({ source_metadata: { ...sourceMetadata, rate_limited: true }, is_duplicate: false, outcome: 'pending' })
      if (r.id) await saveCheckAttachments(r.id)
      return NextResponse.json({ ok: true, outcome: 'pending', queued: true, checkId: r.id })
    }

    // ── Embedding + dedup ─────────────────────────────────────
    const embedding = await tryEmbedding(cleanContent)
    const duplicateOfId = embedding ? await findDuplicateCheck(service, project.id, embedding, snapshot.last_updated_at) : null
    const isDuplicate = !!duplicateOfId

    const row = await insertCheck({
      source_metadata: sourceMetadata, is_duplicate: isDuplicate, duplicate_of_id: duplicateOfId,
      embedding: isDuplicate ? null : embedding, outcome: 'pending',
    })
    if (row.raced || !row.id) return NextResponse.json({ ok: true, message: 'Already processed' })
    await saveCheckAttachments(row.id)

    if (isDuplicate) {
      await logAudit(service, {
        workspaceId: project.workspace_id, actorId: null, actorEmail: GUARDIAN_SYSTEM_ACTOR.email, actorName: GUARDIAN_SYSTEM_ACTOR.name,
        eventType: 'check.duplicate_skipped', entityType: 'guardian_check', entityId: row.id, entityName: project.name,
        metadata: { duplicate_of: duplicateOfId, source: 'email' },
      })
      return NextResponse.json({ ok: true, outcome: 'duplicate' })
    }

    // ── Classify → record → flag ──────────────────────────────
    const res = await classifyAndRecord(service, {
      check: { id: row.id, content: cleanContent },
      project: { id: project.id, name: project.name, workspace_id: project.workspace_id },
      snapshot, sensitivity, actor: GUARDIAN_SYSTEM_ACTOR,
      auditEvent: 'check.classified', emailPath: `Email from ${fromEmail}`,
      flagMeta: { source: 'email', from: fromEmail, sender_known: senderKnown },
    })
    if (res.status === 'failed') {
      // Stored + marked retryable (classification_failed); the sweep and the manual Retry button pick it up.
      return NextResponse.json({ ok: true, outcome: 'classification_failed', checkId: row.id })
    }
    return NextResponse.json({ ok: true, checkId: row.id, outcome: res.classification.outcome })
  } catch (err) {
    console.error('Guardian inbound error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

/** Is the sender the project's client (primary email, CC list, or a saved contact)? */
async function isKnownSender(service: any, workspaceId: string, clientId: string | null, addr: string): Promise<boolean> {
  if (!clientId || !addr) return false
  try {
    const { data: client } = await service.from('clients')
      .select('email, cc_emails').eq('id', clientId).eq('workspace_id', workspaceId).maybeSingle()
    if (!client) return false
    const known = new Set<string>([String(client.email || '').toLowerCase(), ...((client.cc_emails || []) as string[]).map(e => String(e).toLowerCase())])
    if (known.has(addr)) return true
    // FIX (independent pass round 3, section 13): `addr` is always lowercased (senderEmail()
    // lowercases it), but client_contacts.email isn't guaranteed to be — POST/PATCH .../contacts
    // lowercase on write going forward, but rows created before that, or written some other way,
    // may not be, and Postgres `=` is case-sensitive regardless. A saved contact like
    // "Jane@Acme.com" could never match here even though the clients.email/cc_emails check just
    // above it is already case-insensitive via a lowercased Set. ilike matches case-insensitively;
    // FIX (independent pass 13, section 14 — B1): this used `ilike` + escapeLike, but PostgREST reads `*` in an ilike
    // value as `%` (unescapable), so a sender like `a*@x.com` matched a saved contact `ab@x.com` and was treated as
    // the client. A client holds at most 25 contacts: read them and compare exactly, case-insensitively, in code.
    const { data: contacts } = await service.from('client_contacts')
      .select('email').eq('client_id', clientId)
    return (contacts || []).some((c: any) => sameEmail(c.email, addr))
  } catch { return false }
}
