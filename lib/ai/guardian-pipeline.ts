// lib/ai/guardian-pipeline.ts
//
// FIX (independent pass, section 13): api/guardian/check, api/guardian/inbound and
// api/guardian/checks/[id]/retry each carried their own hand-copied version of
// "classify → write the verdict → raise a flag → notify". Three copies drifted:
// none of them checked the error on the guardian_flags insert (a check could end
// `out_of_scope` with no flag, no notification and no trace), none of the result
// writes were error-checked, and retry had no compare-and-swap so two concurrent
// retries both raised a flag. They now share this one implementation, which:
//   * checks every write and reverts the check to a retryable state (instead of
//     silently leaving an orphaned verdict) when the flag can't be created;
//   * lets the same code run from a session (paste / retry) or with no human
//     actor (inbound webhook, cron sweep);
//   * finds duplicates with pgvector in the database — PostgREST returns the
//     `embedding` column as a text literal, which the old in-JS comparison could
//     never read (see parseVector in lib/ai/guardian.ts).

import {
  classifyGuardianCheck, getEmbedding, cosineSimilarity, parseVector, resolveMatchedAmendmentId, toPlainText,
  type Sensitivity, type ClassificationResult,
} from '@/lib/ai/guardian'
import { sendGuardianFlagEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'
import { logAudit } from '@/lib/utils/audit'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'

export const DEDUP_THRESHOLD = 0.85
export const DEDUP_WINDOW_DAYS = 30
/** Automatic (cron) attempts stop here; a person can still retry by hand. */
export const MAX_AUTO_CLASSIFICATION_ATTEMPTS = 5

export interface GuardianActor {
  id: string | null
  email: string
  name: string
  ip?: string | null
}
export const GUARDIAN_SYSTEM_ACTOR: GuardianActor = { id: null, email: 'guardian@scopegov.app', name: 'Guardian', ip: null }

/**
 * The text the embedding (and therefore dedup) is computed over.
 *
 * FIX (independent pass 3, section 13 - B1): this used to be the first 500 characters only. Two submissions that
 * share their first 500 characters embed identically, so a chronological chat/thread that was checked once and then
 * re-pasted with a NEW client request appended at the bottom was marked a duplicate of itself and never classified -
 * a silent scope-creep miss. The embedding input now covers up to EMBED_TEXT_MAX characters (what getEmbedding
 * itself accepts); anything longer keeps its first and last halves, so text appended to the END still moves the vector.
 */
export const EMBED_TEXT_MAX = 2000
export function embeddingText(content: string): string {
  const text = toPlainText(content)
  if (text.length <= EMBED_TEXT_MAX) return text
  const half = Math.floor((EMBED_TEXT_MAX - 1) / 2) // the joining newline takes the last character of the budget
  return `${text.slice(0, half)}\n${text.slice(-half)}`
}

// ── Duplicate detection ───────────────────────────────────────
// Prefers the guardian_find_duplicate_check RPC (migration 073: pgvector `<=>`
// over the whole 30-day window, most-similar first, uses the ivfflat index).
// Falls back to an in-process scan — now ordered newest-first and reading the
// text-literal vector correctly — so a deploy that lands before the migration
// degrades instead of breaking submissions.
export async function findDuplicateCheck(service: any, projectId: string, embedding: number[]): Promise<string | null> {
  const literal = `[${embedding.join(',')}]`
  const { data, error } = await service.rpc('guardian_find_duplicate_check', {
    p_project_id: projectId,
    p_embedding:  literal,
    p_threshold:  DEDUP_THRESHOLD,
    p_since:      new Date(Date.now() - DEDUP_WINDOW_DAYS * 86400000).toISOString(),
  })
  if (!error) return typeof data === 'string' ? data : null

  console.error('guardian_find_duplicate_check RPC failed — falling back to in-process scan:', error.message)
  const { data: recent } = await service
    .from('guardian_checks')
    .select('id, embedding')
    .eq('project_id', projectId)
    .eq('is_duplicate', false)
    .not('embedding', 'is', null)
    .neq('outcome', 'pending')
    .gte('created_at', new Date(Date.now() - DEDUP_WINDOW_DAYS * 86400000).toISOString())
    .order('created_at', { ascending: false })
    .limit(300)
  let best: { id: string; sim: number } | null = null
  for (const c of (recent || [])) {
    const sim = cosineSimilarity(embedding, c.embedding)
    if (sim > DEDUP_THRESHOLD && (!best || sim > best.sim)) best = { id: c.id, sim }
  }
  return best?.id ?? null
}

/** Best-effort embedding — null on failure (dedup is then skipped, not fatal). */
export async function tryEmbedding(content: string): Promise<number[] | null> {
  try { return await getEmbedding(embeddingText(content)) }
  catch (e) { console.error('Embedding failed:', e); return null }
}

export function severityFor(outcome: 'out_of_scope' | 'borderline', creepConfidence: number): 'high' | 'medium' | 'low' | 'info' {
  if (outcome === 'borderline') return 'info'
  return creepConfidence >= 0.90 ? 'high' : creepConfidence >= 0.75 ? 'medium' : 'low'
}

export interface PipelineProject { id: string; name: string; workspace_id: string }
export interface PipelineSnapshot { deliverables?: any[]; out_of_scope?: any[] }

export type PipelineResult =
  | { status: 'classified'; classification: ClassificationResult; flagId: string | null }
  | { status: 'failed'; reason: 'classification' | 'flag' }

export async function classifyAndRecord(service: any, p: {
  check:        { id: string; content: string }
  project:      PipelineProject
  snapshot:     PipelineSnapshot
  sensitivity:  Sensitivity
  actor:        GuardianActor
  /** audit event for the verdict, e.g. check.classified / check.retried / check.swept */
  auditEvent:   string
  /** shown in the flag email ("paste", "Email from …", "retry") */
  emailPath:    string
  /** flag-source metadata merged into the flag audit row */
  flagMeta?:    Record<string, unknown>
  excludeUserId?: string
  /**
   * FIX (independent pass 3, section 13 - B3): record the verdict but raise no flag and notify nobody. Used for a
   * retroactive "log a past check" against a Complete/Archived project, which the UI promises only records the
   * content and never changes live monitoring - a live open flag (and a team email) on a finished project is the
   * opposite, and PATCH /api/projects/[id]/complete exists precisely to leave no open flags on one.
   */
  recordOnly?:  boolean
}): Promise<PipelineResult> {
  const { check, project, snapshot, sensitivity, actor } = p
  const auditBase = {
    workspaceId: project.workspace_id, actorId: actor.id, actorEmail: actor.email, actorName: actor.name,
    ...(actor.ip ? { ipAddress: actor.ip } : {}),
  }

  const markFailed = async (eventType: string, metadata: Record<string, unknown>) => {
    const { error } = await service.from('guardian_checks')
      .update({ classification_failed: true, outcome: 'pending', last_attempt_at: new Date().toISOString() }).eq('id', check.id)
    if (error) console.error('Could not mark check as classification_failed:', error.message)
    await logAudit(service, { ...auditBase, eventType, entityType: 'guardian_check', entityId: check.id, entityName: project.name, metadata })
  }

  // ── classify ──────────────────────────────────────────────
  let amendments: any[] = []
  let classification: ClassificationResult
  try {
    const { data, error } = await service.from('amendments')
      .select('id, title, added_deliverables').eq('project_id', project.id)
    // An unreadable amendments list must not silently degrade to "no COs" — that
    // would misclassify already-covered work as scope creep.
    if (error) throw new Error(`amendments read failed: ${error.message}`)
    amendments = data || []
    classification = await classifyGuardianCheck({
      content: check.content,
      snapshot: { deliverables: snapshot.deliverables || [], outOfScope: snapshot.out_of_scope || [] },
      amendments, sensitivity,
    })
  } catch (classErr) {
    console.error('Classification failed:', classErr)
    await markFailed('check.classification_failed', {})
    return { status: 'failed', reason: 'classification' }
  }

  // ── record the verdict ────────────────────────────────────
  const matchedAmendmentId = resolveMatchedAmendmentId(amendments, classification.matchedAgainst, classification.matchedReference)
  const { error: recordErr } = await service.from('guardian_checks').update({
    match_confidence:     classification.matchConfidence,
    creep_confidence:     classification.creepConfidence,
    matched_against:      classification.matchedAgainst,
    matched_reference:    classification.matchedReference,
    matched_amendment_id: matchedAmendmentId,
    outcome:              classification.outcome,
    classified_at:        new Date().toISOString(),
    classification_failed: false,
  }).eq('id', check.id)
  if (recordErr) {
    console.error('Could not record classification verdict:', recordErr.message)
    await markFailed('check.classification_failed', { stage: 'record_verdict' })
    return { status: 'failed', reason: 'classification' }
  }

  await logAudit(service, {
    ...auditBase, eventType: p.auditEvent, entityType: 'guardian_check', entityId: check.id, entityName: project.name,
    metadata: { outcome: classification.outcome, creep_confidence: classification.creepConfidence },
  })

  if (classification.outcome !== 'out_of_scope' && classification.outcome !== 'borderline') {
    return { status: 'classified', classification, flagId: null }
  }
  if (p.recordOnly) return { status: 'classified', classification, flagId: null }

  // ── raise the flag ────────────────────────────────────────
  // 'borderline' is a deliberate lower-key tier: a 'borderline_review' flag, an
  // in-app notification but no email blast (see the original STEP 6 rationale).
  const isBorderline = classification.outcome === 'borderline'
  const severity = severityFor(classification.outcome, classification.creepConfidence)
  const sowReference = classification.matchedReference || 'General scope'

  const { data: flag, error: flagErr } = await service.from('guardian_flags').insert({
    project_id:    project.id,
    workspace_id:  project.workspace_id,
    check_id:      check.id,
    type:          'scope_creep',
    severity,
    description:   classification.reasoning,
    sow_reference: sowReference,
    status:        isBorderline ? 'borderline_review' : 'open',
  }).select('id').single()

  // FIX (independent pass 2, section 13 - G2): guardian_flags_check_id_unique (migration 123) means a check can own at most
  // one flag. If two runs ever classify the same check concurrently (a live request and a sweep/retry that both got
  // past their claims), the loser lands here: the flag already exists and its winner already notified the team, so
  // link it and return it - no second flag, no second email, and not a "flag creation failed" retry loop.
  if (flagErr && (flagErr as any).code === '23505') {
    const { data: existingFlag } = await service.from('guardian_flags').select('id').eq('check_id', check.id).limit(1).maybeSingle()
    if (existingFlag?.id) {
      const { error: relinkErr } = await service.from('guardian_checks').update({ flag_id: existingFlag.id }).eq('id', check.id)
      if (relinkErr) console.error('Could not link check → existing flag:', relinkErr.message)
      return { status: 'classified', classification, flagId: existingFlag.id }
    }
  }

  if (flagErr || !flag) {
    // Previously ignored: the check kept its out_of_scope verdict with no flag and
    // nobody was ever told. Put it back into the retryable state instead.
    console.error('Guardian flag insert failed:', flagErr?.message)
    await markFailed('check.flag_creation_failed', { outcome: classification.outcome })
    return { status: 'failed', reason: 'flag' }
  }

  const { error: linkErr } = await service.from('guardian_checks').update({ flag_id: flag.id }).eq('id', check.id)
  if (linkErr) console.error('Could not link check → flag:', linkErr.message)

  await logAudit(service, {
    ...auditBase, eventType: isBorderline ? 'flag.borderline_created' : 'flag.raised',
    entityType: 'guardian_flag', entityId: flag.id, entityName: project.name,
    metadata: { severity, creep_confidence: classification.creepConfidence, ...(p.flagMeta || {}) },
  })

  try {
    if (!isBorderline) {
      const emails = await getMemberEmailsWithPermission(
        service, project.workspace_id, 'APPROVE_FLAGS', 25, 'guardian_flag', project.id, p.excludeUserId,
      )
      if (emails.length) {
        // sendGuardianFlagEmail resolves { error } on a provider rejection instead of throwing —
        // checkedSend logs both failure shapes.
        await checkedSend(() => sendGuardianFlagEmail({
          to: emails, projectName: project.name, severity,
          description: classification.reasoning, sowReference,
          projectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=guardian`,
          path: p.emailPath,
        }), 'guardian flag email')
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
      ...(p.excludeUserId ? { excludeUserId: p.excludeUserId } : {}),
    })
  } catch (notifyErr) {
    // The flag exists and is visible in the Guardian tab; a notification hiccup
    // must not turn the whole request into a 500 (which made Postmark re-deliver
    // the email and re-run the entire pipeline).
    console.error('Guardian flag notification failed:', notifyErr)
  }

  return { status: 'classified', classification, flagId: flag.id }
}

// ── Re-classify a stored check in place ───────────────────────
// Used by the manual retry route and by the guardian-health cron sweep (which
// also picks up checks that were stored `pending` because no signed SOW existed
// at submission time — those were previously stranded forever).
export type ReclassifyResult =
  | { status: 'classified'; classification: ClassificationResult; flagId: string | null; project: PipelineProject }
  | { status: 'failed'; reason: 'classification' | 'flag' }
  | { status: 'skipped'; reason: 'not_found' | 'not_eligible' | 'no_snapshot' | 'max_attempts' | 'claimed' | 'inactive' }
  | { status: 'duplicate'; duplicateOfId: string }

export async function reclassifyCheck(service: any, checkId: string, opts: {
  actor: GuardianActor
  auditEvent: string
  emailPath: string
  workspaceId?: string
  excludeUserId?: string
  /** true = only classification_failed checks (manual retry); false = also unclassified backlog */
  requireFailed?: boolean
  maxAttempts?: number
  // FIX (independent pass round 4, section 13): both callers of this function (the manual retry
  // route and the guardian-health cron sweep) used to call recordAiUsage/recordAiUsageByProject
  // themselves BEFORE calling this — meaning a call that turned out to be 'not_eligible',
  // 'no_snapshot', 'max_attempts', or lost the CAS race ('claimed') still recorded a paid AI
  // attempt despite this function never reaching the embedding or classification call. That
  // burned the caller's rate-limit budget and inflated the workspace's AI usage totals for
  // attempts that made zero provider calls — most visible as a double-click or two-tab race
  // silently costing two credits for one real classification. Usage is now recorded here,
  // exactly once, right after the CAS claim succeeds — the one point past which this function is
  // guaranteed to actually do embedding/dedup/classification work, matching how check/route.ts
  // and inbound/route.ts already record usage immediately after their own first paid call rather
  // than before knowing whether one will happen. Optional so a caller that doesn't meter usage
  // (there is none today, but this stays a library function) isn't forced to supply one.
  recordUsage?: () => Promise<void>
}): Promise<ReclassifyResult> {
  let q = service.from('guardian_checks')
    .select('id, project_id, workspace_id, content, is_duplicate, outcome, classification_failed, classification_attempts, source, source_metadata, embedding')
    .eq('id', checkId)
  if (opts.workspaceId) q = q.eq('workspace_id', opts.workspaceId)
  const { data: check } = await q.maybeSingle()
  if (!check) return { status: 'skipped', reason: 'not_found' }

  if (check.is_duplicate || check.outcome !== 'pending') return { status: 'skipped', reason: 'not_eligible' }
  if (opts.requireFailed && !check.classification_failed) return { status: 'skipped', reason: 'not_eligible' }
  const attempts = Number(check.classification_attempts || 0)
  if (attempts >= (opts.maxAttempts ?? Infinity)) return { status: 'skipped', reason: 'max_attempts' }

  const { data: project } = await service.from('projects')
    .select(`id, name, status, deleted_at, workspace_id, workspaces(id, guardian_sensitivity_tier, deleted_at), project_scope_snapshot(deliverables, out_of_scope)`)
    .eq('id', check.project_id).eq('workspace_id', check.workspace_id).maybeSingle()
  if (!project) return { status: 'skipped', reason: 'not_found' }
  // Same gates as live submission: nothing is classified, flagged or emailed for a deleted project,
  // a Complete/Archived one, or a suspended/deleted workspace. Checked BEFORE the claim so no
  // attempt is burned and no AI usage recorded.
  if (project.deleted_at || !project.workspaces || project.workspaces.deleted_at || ['Complete', 'Archived'].includes(project.status))
    return { status: 'skipped', reason: 'inactive' }
  const snapshot = project.project_scope_snapshot
  if (!snapshot) return { status: 'skipped', reason: 'no_snapshot' }

  // Compare-and-swap claim: two concurrent retries/sweeps both read attempts=N;
  // only one can move it to N+1, the other backs off (previously both classified
  // and both raised a flag).
  const { data: claimed } = await service.from('guardian_checks')
    .update({ classification_attempts: attempts + 1, last_attempt_at: new Date().toISOString() })
    .eq('id', check.id).eq('classification_attempts', attempts).eq('outcome', 'pending')
    .select('id')
  if (!claimed || claimed.length === 0) return { status: 'skipped', reason: 'claimed' }

  // Past this point a real attempt is genuinely underway (embedding-if-needed, dedup, and/or
  // classification all happen below) — see this function's opts comment for why usage recording
  // belongs exactly here and not in the caller.
  if (opts.recordUsage) {
    try { await opts.recordUsage() } catch (e) { console.error('Could not record AI usage:', e) }
  }

  // Backlog rows (rate-limited inbound / no-snapshot at submission) may have no embedding.
  let embedding = parseVector(check.embedding)
  if (!embedding) {
    const emb = await tryEmbedding(check.content)
    if (emb) {
      embedding = emb
      await service.from('guardian_checks').update({ embedding: emb }).eq('id', check.id)
    }
  }

  // FIX (independent pass round 2, section 13 — flagship finding): this backlog path (the cron
  // sweep AND manual retry both go through here) never ran duplicate detection at all — only the
  // two LIVE submission paths (guardian/check, guardian/inbound) ever called findDuplicateCheck,
  // before the row was first inserted. A project with no signed SOW yet, or one that's hit the
  // inbound rate limit, can perfectly well receive the same client request more than once (a
  // forwarded thread, a client re-sending because they got no reply) — each arrives as its own
  // `pending` row with is_duplicate:false, since dedup only ever ran on submission and these were
  // never eligible for it there. Once the SOW is signed (or the limit clears) and this function
  // finally classifies them, every one of those was getting classified — and flagged — completely
  // independently, exactly the multi-flag/multi-email noise the live-path dedup exists to prevent.
  // Run the same pgvector lookup the live paths use, now that this row has an embedding to check,
  // and resolve it the same way check/route.ts does for a live duplicate: is_duplicate:true,
  // duplicate_of_id set, embedding cleared, outcome left at 'pending' (that combination is what
  // both the history view and sweepUnclassified's own `.eq('is_duplicate', false)` filter already
  // treat as "this is a duplicate, not backlog" — so a match here also retires it from future
  // sweeps without adding a new outcome value anywhere those are read).
  if (embedding) {
    const duplicateOfId = await findDuplicateCheck(service, check.project_id, embedding)
    if (duplicateOfId) {
      const { error: dupErr } = await service.from('guardian_checks')
        // FIX (independent pass, section 13): also clear classification_failed. A check that failed classification
        // and is later found to duplicate an already-classified one stayed classification_failed:true — the history
        // row then showed BOTH "duplicate" and a "Retry classification" button that could only ever 400, and the
        // guardian-health "unresolved failures >24h" alert kept firing on it every run until someone deleted it.
        .update({ is_duplicate: true, duplicate_of_id: duplicateOfId, embedding: null, classification_failed: false })
        .eq('id', check.id)
      if (dupErr) console.error('Could not mark backlog check as duplicate:', dupErr.message)
      await logAudit(service, {
        workspaceId: project.workspace_id, actorId: opts.actor.id, actorEmail: opts.actor.email,
        actorName: opts.actor.name, eventType: 'check.duplicate_skipped', entityType: 'guardian_check',
        entityId: check.id, entityName: project.name, metadata: { duplicate_of: duplicateOfId, stage: 'backlog' },
      })
      return { status: 'duplicate', duplicateOfId }
    }
  }

  const from = check.source_metadata?.from
  const res = await classifyAndRecord(service, {
    check: { id: check.id, content: check.content },
    project: { id: project.id, name: project.name, workspace_id: project.workspace_id },
    snapshot,
    sensitivity: (project.workspaces?.guardian_sensitivity_tier || 'medium') as Sensitivity,
    actor: opts.actor, auditEvent: opts.auditEvent,
    emailPath: from ? `Email from ${from}` : opts.emailPath,
    flagMeta: from ? { source: 'email', from } : { source: check.source },
    excludeUserId: opts.excludeUserId,
  })
  if (res.status === 'failed') return res
  return { ...res, project: { id: project.id, name: project.name, workspace_id: project.workspace_id } }
}
