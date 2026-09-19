export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { classifyGuardianCheck, getEmbedding, cosineSimilarity, resolveMatchedAmendmentId, type Sensitivity } from '@/lib/ai/guardian'
import { stripHtml } from '@/lib/utils/format'
import { sendGuardianFlagEmail } from '@/lib/email/templates'
import { logAudit } from '@/lib/utils/audit'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { checkAiRateLimitByProject, recordAiUsageByProject } from '@/lib/utils/rate-limit'

// BUG-016: verify Postmark webhook signature before processing
// FIX (audit round 2, item #4): plain `===` on a hex digest is not
// constant-time — comparison can short-circuit on the first mismatched
// byte, which is a (low-probability but non-zero) timing side-channel for
// an attacker trying to forge this webhook's signature. Use
// crypto.timingSafeEqual, guarding the length check first since it throws
// on mismatched buffer lengths rather than just returning false.
function verifyPostmarkSignature(body: string, signature: string | null): boolean {
  if (!signature) return false
  const secret = process.env.POSTMARK_INBOUND_WEBHOOK_SECRET
  if (!secret) return false
  // Postmark uses HMAC-SHA256
  const crypto = require('crypto')
  const expected = crypto.createHmac('sha256', secret).update(body).digest()
  let provided: Buffer
  try { provided = Buffer.from(signature, 'hex') } catch { return false }
  if (provided.length !== expected.length) return false
  return crypto.timingSafeEqual(expected, provided)
}

export async function POST(request: NextRequest) {
  try {
    const rawBody  = await request.text()
    const sig      = request.headers.get('x-postmark-signature')

    if (!verifyPostmarkSignature(rawBody, sig)) {
      console.warn('Postmark signature verification failed')
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    let payload: any
    try { payload = JSON.parse(rawBody) }
    catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

    const toEmail    = payload.OriginalRecipient || payload.To || ''
    const fromEmail  = payload.From || ''
    const subject    = payload.Subject || ''
    const textBody   = payload.TextBody || ''
    const htmlBody   = payload.HtmlBody || ''
    const content    = textBody || stripHtml(htmlBody)

    if (!content.trim()) {
      return NextResponse.json({ ok: true, message: 'Empty content — skipped' })
    }

    // Extract project ID from guardian email address
    // Format: proj-{8chars}@guard.scopegov.app
    const guardianDomain = process.env.NEXT_PUBLIC_GUARDIAN_EMAIL_DOMAIN || 'guard.scopegov.app'
    // FIX (audit round 6): String.replace('.', ...) with no /g flag only
    // escapes the FIRST dot. For a two-dot domain like guard.scopegov.app,
    // the second dot stayed a live regex wildcard (matches any character),
    // loosening the match beyond what was intended. Escape every dot.
    const emailMatch     = toEmail.match(new RegExp(`proj-([a-z0-9]+)@${guardianDomain.replace(/\./g, '\\.')}`, 'i'))
    if (!emailMatch) {
      return NextResponse.json({ ok: true, message: 'Not a Guardian address — ignored' })
    }

    const guardianPrefix = emailMatch[1]
    const service        = createServiceClient()

    // Find project by guardian_email
    // FIX (deep audit, Settings section — missing-column bug): same
    // unchecked-error pattern as /api/guardian/check — see that route's
    // comment. Distinguish "query errored" from "genuinely no matching
    // project" in the logs rather than lumping both under one warning.
    const { data: project, error: projectErr } = await (service as any)
      .from('projects')
      .select(`id, name, status, workspace_id,
        workspaces(id, agency_name, guardian_sensitivity_tier),
        project_scope_snapshot(deliverables, out_of_scope)`)
      .ilike('guardian_email', `proj-${guardianPrefix}@%`)
      .single()

    if (!project) {
      if (projectErr) console.error('Guardian inbound: project fetch failed', projectErr)
      else console.warn(`No project found for guardian email prefix: ${guardianPrefix}`)
      return NextResponse.json({ ok: true, message: 'No matching project' })
    }

    // Auto-reply if project is Archived/Complete
    if (['Archived','Complete'].includes(project.status)) {
      // Spec §5.2: archived/completed projects auto-reply
      return NextResponse.json({ ok: true, message: 'Project inactive — auto-reply handled by Postmark' })
    }

    // Strip quoted replies — take first 500 chars of unquoted content
    const cleanContent = extractUnquotedContent(content)
    if (!cleanContent.trim() || cleanContent.length < 20) {
      return NextResponse.json({ ok: true, message: 'Only quoted reply — skipped' })
    }

    const sensitivity = (project.workspaces?.guardian_sensitivity_tier || 'medium') as Sensitivity
    // FIX: one-to-one relation (see /api/guardian/check for details) — no [0]
    const snapshot    = project.project_scope_snapshot

    // FIX (audit round 6): this route runs the exact same paid embedding +
    // classification pipeline as /api/guardian/check, which got rate
    // limiting in a prior round specifically because of that cost — this
    // sibling endpoint was missed. It's arguably the higher-risk of the
    // two: it needs zero UI interaction, just email volume to the
    // project's guardian address. No user session exists here to key a
    // limit on, so this is keyed by project instead (see rate-limit.ts).
    const limited = await checkAiRateLimitByProject(service, project.id, 'guardian.inbound')
    if (!limited.allowed) {
      console.warn(`Guardian inbound rate limit hit for project ${project.id}`)
      return NextResponse.json({ ok: true, message: 'Rate limited — try again later' })
    }

    // ── Embedding + dedup ─────────────────────────────────────
    let embedding: number[] | null = null
    try { embedding = await getEmbedding(cleanContent.slice(0, 500)) }
    catch { /* non-fatal */ }

    // FIX (audit round 6): record usage as soon as a real attempt was made
    // (same reasoning as api/guardian/check) rather than only on the
    // eventual full-success path.
    await recordAiUsageByProject(service, project.workspace_id, project.id, 'guardian.inbound')

    let isDuplicate    = false
    let duplicateOfId: string | null = null

    if (embedding) {
      // FIX (re-audit): same dead-end dedup gap as guardian/check — see that
      // file's note. A check that was never actually classified ('pending'
      // or 'classification_failed') must not be a valid dedup match, or a
      // legitimate resubmission just silently bounces off the orphaned
      // original forever instead of ever getting classified.
      const { data: recentChecks } = await (service as any)
        .from('guardian_checks')
        .select('id, embedding')
        .eq('project_id', project.id)
        .eq('is_duplicate', false)
        .not('embedding', 'is', null)
        .neq('outcome', 'pending')
        .neq('outcome', 'classification_failed')
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        .limit(100)

      for (const check of (recentChecks || [])) {
        if (!check.embedding) continue
        if (cosineSimilarity(embedding, check.embedding) > 0.85) {
          isDuplicate = true; duplicateOfId = check.id; break
        }
      }
    }

    // Write check row
    const { data: checkRow } = await (service as any).from('guardian_checks').insert({
      project_id:      project.id,
      workspace_id:    project.workspace_id,
      content:         cleanContent,
      source:          'email',
      source_metadata: { from: fromEmail, subject, to: toEmail },
      submitted_by:    null, // inbound — no user session
      submitted_at:    new Date().toISOString(),
      is_duplicate:    isDuplicate,
      duplicate_of_id: duplicateOfId,
      embedding:       isDuplicate ? null : embedding,
      outcome:         'pending',
    }).select('id').single()

    if (isDuplicate || !snapshot || !checkRow) {
      return NextResponse.json({ ok: true, outcome: isDuplicate ? 'duplicate' : 'pending' })
    }

    // ── Classify ──────────────────────────────────────────────
    const { data: amendments } = await (service as any)
      .from('amendments').select('id,title,added_deliverables').eq('project_id', project.id)

    let classification
    try {
      classification = await classifyGuardianCheck({
        content: cleanContent,
        snapshot: { deliverables: snapshot.deliverables || [], outOfScope: snapshot.out_of_scope || [] },
        amendments: amendments || [],
        sensitivity,
      })
    } catch {
      await (service as any).from('guardian_checks')
        .update({ classification_failed: true }).eq('id', checkRow.id)
      return NextResponse.json({ ok: true, outcome: 'classification_failed' })
    }

    // FIX (deep audit, section 13 — feature gap): see resolveMatchedAmendmentId's
    // comment in lib/ai/guardian.ts — mirrors the same fix in api/guardian/check.
    const matchedAmendmentId = resolveMatchedAmendmentId(
      amendments || [], classification.matchedAgainst, classification.matchedReference,
    )
    await (service as any).from('guardian_checks').update({
      match_confidence:  classification.matchConfidence,
      creep_confidence:  classification.creepConfidence,
      matched_against:   classification.matchedAgainst,
      matched_reference: classification.matchedReference,
      matched_amendment_id: matchedAmendmentId,
      outcome:           classification.outcome,
      classified_at:     new Date().toISOString(),
    }).eq('id', checkRow.id)

    // ── Create flag if out_of_scope OR borderline ─────────────
    // FIX (audit round 6): mirrors api/guardian/check — 'borderline' used
    // to be a dead end here too. See that route's STEP 6 comment for the
    // full reasoning.
    if (classification.outcome === 'out_of_scope' || classification.outcome === 'borderline') {
      const isBorderline = classification.outcome === 'borderline'
      const severity = isBorderline ? 'info' : (
        classification.creepConfidence >= 0.90 ? 'high'
        : classification.creepConfidence >= 0.75 ? 'medium' : 'low'
      )

      const { data: flag } = await (service as any).from('guardian_flags').insert({
        project_id:    project.id,
        workspace_id:  project.workspace_id,
        check_id:      checkRow.id,
        type:          'scope_creep',
        severity,
        description:   classification.reasoning,
        sow_reference: classification.matchedReference || 'General scope',
        status:        isBorderline ? 'borderline_review' : 'open',
      }).select('id').single()

      if (flag) {
        await (service as any).from('guardian_checks').update({ flag_id: flag.id }).eq('id', checkRow.id)

        if (!isBorderline) {
          // Notify APPROVE_FLAGS holders — full-confidence flags only
          const emails = await getMemberEmailsWithPermission(service, project.workspace_id, 'APPROVE_FLAGS', 25, 'guardian_flag', project.id)
          if (emails.length) {
            try {
              await sendGuardianFlagEmail({
                to: emails,
                projectName:  project.name,
                severity,
                description:  classification.reasoning,
                sowReference: classification.matchedReference || 'General scope',
                projectUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=guardian`,
                path:         `Email from ${fromEmail}`,
              })
            } catch (e) { console.error('Flag email failed:', e) }
          }
        }
        await notifyMembersWithPermission(service, {
          workspaceId: project.workspace_id, permission: 'APPROVE_FLAGS', eventType: 'guardian_flag',
          type: 'guardian_flag',
          title: isBorderline ? `Borderline scope item — ${project.name}` : `Scope flag — ${project.name}`,
          body: classification.reasoning?.slice(0, 140) || (isBorderline
            ? 'A possible scope item needs a quick look.'
            : 'A new out-of-scope request was flagged.'),
          entityType: 'project', entityId: project.id, projectId: project.id,
        })

        // FIX (re-audit): was actorId: 'system' — an invalid uuid for the
        // actor_id FK, which made this insert fail silently every time
        // (see lib/utils/audit.ts). null is the correct "no human actor"
        // value; actorName/actorEmail below still identify this as Guardian.
        await logAudit(service, {
          workspaceId: project.workspace_id, actorId: null,
          actorEmail: 'guardian@scopegov.app', actorName: 'Guardian',
          eventType: isBorderline ? 'flag.borderline_created' : 'flag.raised', entityType: 'guardian_flag',
          entityId: flag.id, entityName: project.name,
          metadata: { severity, source: 'email', from: fromEmail },
        })
      }
    }

    return NextResponse.json({ ok: true, checkId: checkRow.id, outcome: classification.outcome })
  } catch (err) {
    console.error('Guardian inbound error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

function extractUnquotedContent(text: string): string {
  // Remove quoted reply lines (starting with >) and forwarded message headers
  const lines = text.split('\n')
  const unquoted = lines.filter(line => {
    const trimmed = line.trim()
    if (trimmed.startsWith('>')) return false
    if (trimmed.match(/^On .+ wrote:$/)) return false
    if (trimmed.match(/^-{3,}/)) return false
    if (trimmed.match(/^From:\s/i)) return false
    if (trimmed.match(/^Sent:\s/i)) return false
    return true
  })
  return unquoted.join('\n').trim()
}
