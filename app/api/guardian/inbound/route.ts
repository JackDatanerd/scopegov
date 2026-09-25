export const runtime = 'nodejs'

import crypto from 'crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { toPlainText, MAX_CHECK_CONTENT_CHARS, type Sensitivity } from '@/lib/ai/guardian'
import { classifyAndRecord, findDuplicateCheck, tryEmbedding, GUARDIAN_SYSTEM_ACTOR } from '@/lib/ai/guardian-pipeline'
import {
  extractUnquotedContent, isForwardSubject, cleanSubject, isAutomatedMessage, senderEmail, matchGuardianAddress,
} from '@/lib/ai/guardian-email'
import { logAudit } from '@/lib/utils/audit'
import { checkAiRateLimitByProject, recordAiUsageByProject } from '@/lib/utils/rate-limit'
import { EVIDENCE_BUCKET } from '@/lib/utils/storage-cleanup'
import { ALLOWED_ATTACHMENT_TYPES, matchesDeclaredType } from '@/lib/utils/file-signature'

// BUG-016: verify the Postmark inbound webhook before processing.
//
// FIX (deep audit, section 13 — flagship finding): this route used to
// check an `x-postmark-signature` header against an HMAC-SHA256 digest —
// a scheme Postmark has never implemented. Postmark's own docs are
// explicit: "Postmark doesn't sign webhooks with HMAC. Protect the
// endpoint with HTTP Basic Authentication and IP allowlisting." There is
// no per-webhook signing secret to "copy" from Postmark's dashboard the
// way the old comment (and the README) claimed — inbound auth is done by
// embedding credentials directly in the webhook URL Postmark is
// configured to POST to (https://<user>:<password>@host/path), which
// Postmark then sends back as a standard `Authorization: Basic ...`
// header on every request. Every prior audit round hardened the *compare*
// (timing-safe equality, escaping the domain regex) without ever
// verifying the mechanism itself against a real Postmark request — so
// this route has almost certainly been rejecting 100% of genuine inbound
// email with a 401 since the feature shipped. Switched to what Postmark
// actually sends: HTTP Basic Auth, checked with a timing-safe comparison
// on the password half (the username is caller-chosen and not itself a
// secret — POSTMARK_INBOUND_WEBHOOK_SECRET is the value that must match).
// See README §4 for the updated setup steps.
function verifyPostmarkAuth(request: NextRequest): boolean {
  const expectedPassword = process.env.POSTMARK_INBOUND_WEBHOOK_SECRET
  if (!expectedPassword) return false

  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Basic ')) return false

  let decoded: string
  try { decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8') }
  catch { return false }

  // Basic Auth payload is "user:password" — the username is arbitrary
  // (Postmark just echoes back whatever was in the configured URL), only
  // the password half is the actual shared secret.
  const sep = decoded.indexOf(':')
  const password = sep === -1 ? decoded : decoded.slice(sep + 1)

  const expected = Buffer.from(expectedPassword)
  const actual   = Buffer.from(password)
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(expected, actual)
}

export async function POST(request: NextRequest) {
  try {
    if (!verifyPostmarkAuth(request)) {
      console.warn('Postmark inbound auth failed')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const rawBody  = await request.text()
    let payload: any
    try { payload = JSON.parse(rawBody) }
    catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

    const toEmail    = String(payload.OriginalRecipient || payload.To || '')
    const fromEmail  = String(payload.From || '')
    const fromAddr   = senderEmail(payload)
    const subject    = String(payload.Subject || '')
    const messageId  = typeof payload.MessageID === 'string' && payload.MessageID ? payload.MessageID.slice(0, 200) : null

    // Extract the project from the guardian address (proj-{8chars}@guard.scopegov.app).
    // matchGuardianAddress anchors the whole address (the old regex also matched
    // "evilproj-abc@…" and "proj-abc@guard.scopegov.app.evil.com").
    const guardianDomain = process.env.NEXT_PUBLIC_GUARDIAN_EMAIL_DOMAIN || 'guard.scopegov.app'
    const guardianPrefix = matchGuardianAddress(toEmail, guardianDomain)
    if (!guardianPrefix) {
      return NextResponse.json({ ok: true, message: 'Not a Guardian address — ignored' })
    }

    // Bounces / out-of-office / list mail would otherwise cost two AI calls each and raise junk flags.
    if (isAutomatedMessage(payload)) {
      return NextResponse.json({ ok: true, message: 'Automated message — skipped' })
    }

    const service = createServiceClient()

    const { data: projects, error: projectErr } = await (service as any)
      .from('projects')
      .select(`id, name, status, stall_reason, workspace_id, client_id,
        workspaces(id, agency_name, guardian_sensitivity_tier),
        project_scope_snapshot(deliverables, out_of_scope)`)
      .ilike('guardian_email', `proj-${guardianPrefix}@%`)
      .limit(1)
    const project = projects?.[0]

    if (!project) {
      // A read error must be retried by Postmark (500), not swallowed as "no such project".
      if (projectErr) {
        console.error('Guardian inbound: project fetch failed', projectErr)
        return NextResponse.json({ error: 'Internal error' }, { status: 500 })
      }
      console.warn(`No project found for guardian email prefix: ${guardianPrefix}`)
      return NextResponse.json({ ok: true, message: 'No matching project' })
    }

    // Archived / Complete projects accept no new checks. (There is deliberately NO auto-reply:
    // Postmark inbound never sends one, and replying to an unauthenticated sender's
    // address is a backscatter vector. The old comment claiming Postmark handles it was wrong.)
    if (['Archived', 'Complete'].includes(project.status)) {
      return NextResponse.json({ ok: true, message: 'Project inactive — message not processed' })
    }

    // Idempotency: Postmark re-delivers on any non-2xx (and after our own 500s). Without this a
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

    // ── Build the text to classify ────────────────────────────
    // Prefer Postmark's own reply-stripping; fall back to ours. The SUBJECT is part of the
    // request ("Request: add a Spanish version") and used to be dropped entirely.
    const isForward = isForwardSubject(subject)
    const stripped  = typeof payload.StrippedTextReply === 'string' ? toPlainText(payload.StrippedTextReply) : ''
    const fullText  = payload.TextBody ? toPlainText(String(payload.TextBody)) : toPlainText(String(payload.HtmlBody || ''))
    const bodyText  = (!isForward && stripped) ? stripped : extractUnquotedContent(fullText, { isForward })
    const subj      = cleanSubject(subject)
    let cleanContent = [subj ? `Subject: ${subj}` : '', bodyText].filter(Boolean).join('\n\n').trim()
    if (cleanContent.length > MAX_CHECK_CONTENT_CHARS) cleanContent = cleanContent.slice(0, MAX_CHECK_CONTENT_CHARS)

    // The old floor was 20 characters, which discarded real requests like "Add dark mode".
    if (cleanContent.length < 8 || (!bodyText && !subj)) {
      return NextResponse.json({ ok: true, message: 'Only quoted reply — skipped' })
    }

    const sensitivity = (project.workspaces?.guardian_sensitivity_tier || 'medium') as Sensitivity
    const snapshot    = project.project_scope_snapshot // one-to-one → object

    // ── Sender recognition (informational — never blocks) ─────
    const senderKnown = await isKnownSender(service, project.workspace_id, project.client_id, fromAddr)
    const rawAttachments: any[] = Array.isArray(payload.Attachments) ? payload.Attachments.slice(0, 10) : []
    const attachments = rawAttachments.map((a: any) => String(a?.Name || '').slice(0, 120)).filter(Boolean)
    const sourceMetadata: Record<string, unknown> = {
      from: fromEmail, from_address: fromAddr, subject, to: toEmail,
      ...(messageId ? { message_id: messageId } : {}),
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
        throw new Error(`Could not store check: ${error.message}`) // → 500 → Postmark redelivers (was: silent 200 = email lost)
      }
      return { id: data.id as string, raced: false }
    }

    // FEATURE (independent pass round 2, section 13 — feature gap): Postmark's payload carries
    // each attachment's base64 Content alongside its Name, but only the Name was ever kept
    // (`attachments` above, in source_metadata) — the file itself was discarded. Best-effort: a
    // bad/oversized/unrecognised attachment is skipped and logged, never turns a stored,
    // otherwise-successful check into a 500 (which would make Postmark redeliver the whole email).
    // Same private bucket + magic-byte validation the manual flag/exception evidence upload uses
    // (lib/utils/file-signature.ts) — this is the same kind of file, just arriving by a different
    // door. Saved regardless of which branch below stores the row (queued-pending / rate-limited /
    // classified) — the client's evidence matters even for a check that isn't classified yet.
    const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 10 MB — matches the manual-upload cap
    const saveCheckAttachments = async (checkId: string) => {
      for (const a of rawAttachments) {
        try {
          const name = String(a?.Name || '').slice(0, 200) || 'attachment'
          const contentType = String(a?.ContentType || '').split(';')[0].trim().toLowerCase()
          const b64 = typeof a?.Content === 'string' ? a.Content : null
          if (!b64 || !ALLOWED_ATTACHMENT_TYPES.has(contentType)) continue
          const buffer = Buffer.from(b64, 'base64')
          if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) continue
          if (!matchesDeclaredType(contentType, buffer)) continue
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

    // ── No signed SOW yet: keep the mail, spend nothing ───────
    // Re-classified automatically by the guardian-health sweep after the SOW is signed.
    if (!snapshot) {
      const r = await insertCheck({ source_metadata: sourceMetadata, is_duplicate: false, outcome: 'pending' })
      if (r.id) await saveCheckAttachments(r.id)
      return NextResponse.json({ ok: true, outcome: 'pending', checkId: r.id })
    }

    // ── Rate limit: KEEP the email (previously dropped with a 200 → lost forever) ──
    const limited = await checkAiRateLimitByProject(service, project.id, 'guardian.inbound')
    if (!limited.allowed) {
      console.warn(`Guardian inbound rate limit hit for project ${project.id} — queued for sweep`)
      const r = await insertCheck({ source_metadata: { ...sourceMetadata, rate_limited: true }, is_duplicate: false, outcome: 'pending' })
      if (r.id) await saveCheckAttachments(r.id)
      return NextResponse.json({ ok: true, outcome: 'pending', queued: true, checkId: r.id })
    }

    // ── Embedding + dedup ─────────────────────────────────────
    const embedding = await tryEmbedding(cleanContent)
    await recordAiUsageByProject(service, project.workspace_id, project.id, 'guardian.inbound')
    const duplicateOfId = embedding ? await findDuplicateCheck(service, project.id, embedding) : null
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
    const { data: contact } = await service.from('client_contacts')
      .select('id').eq('client_id', clientId).eq('email', addr).limit(1)
    return !!contact?.length
  } catch { return false }
}
