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
  netAmendmentDeliverables,
  type Sensitivity, type ClassificationResult,
} from '@/lib/ai/guardian'
import { sendGuardianFlagEmail } from '@/lib/email/templates'
import { checkedSend } from '@/lib/email/delivery'
import { logAudit } from '@/lib/utils/audit'
import { stripUnstorableText, truncateText } from '@/lib/utils/sanitize'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { PROJECT_COMPLETE_CLOSE_PREFIX } from '@/lib/utils/project-status'

export const DEDUP_THRESHOLD = 0.85
export const DEDUP_WINDOW_DAYS = 30
/** Automatic (cron) attempts stop here; a person can still retry by hand. */
export const MAX_AUTO_CLASSIFICATION_ATTEMPTS = 5
// Checks older than this are never picked up by the guardian-health sweep (see cron/guardian-health) - the history
// panel uses the same cut-off so it never promises an automatic check that will not happen.
export const GUARDIAN_SWEEP_MAX_AGE_DAYS = 90

// FIX (independent pass 4, section 13 - B5): the sweep fetched the 40 OLDEST candidate rows and only THEN dropped the
// ones still inside their backoff window. Rows waiting out a long backoff (15m, 30m, 1h, 2h, 4h per attempt) kept
// occupying those 40 slots, so during an Anthropic outage newer rows - including ones that were due - were never even
// looked at until the older ones burned their last attempt (~8h). The due-ness test now lives in the query: one
// bounded query per attempt count, each filtered to rows whose own backoff has elapsed (or that were never attempted
// and are past the live-path grace), so every row the sweep reads is one it can actually work on.
export const GUARDIAN_SWEEP_BACKOFF_BASE_MS = 15 * 60000   // 15m, 30m, 60m, ... per failed attempt
// guardian/check and guardian/inbound INSERT the row as `pending` (attempts 0, last_attempt_at null) and classify it
// without claiming it; a sweep inside that window would classify it in parallel (two flags, two emails). A row younger
// than this is left to its live request; one whose request died mid-flight is still swept, just this much later.
export const GUARDIAN_LIVE_PATH_GRACE_MS = 10 * 60000

export function sweepAttemptCutoffs(nowMs: number, maxAttempts: number = MAX_AUTO_CLASSIFICATION_ATTEMPTS) {
  return Array.from({ length: Math.max(0, maxAttempts) }, (_, attempts) => ({
    attempts,
    attemptedBefore: new Date(nowMs - GUARDIAN_SWEEP_BACKOFF_BASE_MS * Math.pow(2, attempts)).toISOString(),
    createdBefore: new Date(nowMs - GUARDIAN_LIVE_PATH_GRACE_MS).toISOString(),
  }))
}

/** PostgREST `or` filter selecting the rows of one attempt bucket whose backoff / grace has elapsed. */
export function sweepDueFilter(c: { attemptedBefore: string; createdBefore: string }): string {
  return `last_attempt_at.lte.${c.attemptedBefore},and(last_attempt_at.is.null,created_at.lte.${c.createdBefore})`
}

/** Same rule in JS - kept as a backstop on the rows the due-filtered queries return. */
export function isSweepDue(r: { last_attempt_at?: string | null; created_at: string; classification_attempts?: number | null }, nowMs: number): boolean {
  if (!r.last_attempt_at) return nowMs - new Date(r.created_at).getTime() >= GUARDIAN_LIVE_PATH_GRACE_MS
  const wait = GUARDIAN_SWEEP_BACKOFF_BASE_MS * Math.pow(2, Number(r.classification_attempts || 0))
  return nowMs - new Date(r.last_attempt_at).getTime() >= wait
}


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
  return stripUnstorableText(`${text.slice(0, half)}\n${text.slice(-half)}`) // a cut can split an emoji; repair it
}

// ── Duplicate detection ───────────────────────────────────────
// Prefers the guardian_find_duplicate_check RPC (migration 073: pgvector `<=>`
// over the whole 30-day window, most-similar first, uses the ivfflat index).
// Falls back to an in-process scan — now ordered newest-first and reading the
// text-literal vector correctly — so a deploy that lands before the migration
// degrades instead of breaking submissions.
/**
 * FIX (independent pass 10, section 13 - B1): the duplicate window was a flat 30 days, so a check classified against the
 * OLD scope kept swallowing new requests after the scope had changed. A client asks for "Mobile app" (covered_by_co); a
 * credit/descope CO then moves it back to out_of_scope; the client asks again inside 30 days and the new message was marked
 * a duplicate of the old `covered_by_co` check - never classified, never flagged, no email. A SOW re-sign or a rename through
 * scope-adjustment does the same. The window now starts at the LATER of 30 days ago and the last time the scope snapshot
 * changed (project_scope_snapshot.last_updated_at - every writer of the snapshot bumps it), so only checks judged against the
 * current scope can be matched. Conservative on purpose: a change order that only ADDS scope also moves it, which at worst
 * re-classifies a re-sent message once.
 */
export function dedupSinceIso(nowMs: number, scopeChangedAt?: string | null): string {
  const windowStart = nowMs - DEDUP_WINDOW_DAYS * 86400000
  const changed = scopeChangedAt ? Date.parse(scopeChangedAt) : NaN
  return new Date(Number.isFinite(changed) ? Math.max(windowStart, changed) : windowStart).toISOString()
}

/**
 * FIX (independent pass 13, section 13 - B1): the duplicate lookup matched ANY classified check in the window, but an
 * `out_of_scope` / `borderline` verdict only protects the team when a flag came out of it. Two cases left a request
 * swallowed with nobody ever told:
 *   - a retroactive check on a Complete/Archived project is recorded with `recordOnly` (verdict, no flag). After the
 *     project is reopened (the snapshot - and so the window - does not move) the client re-sends the same request and
 *     it matched that flagless record: marked duplicate, never classified, no flag, no email;
 *   - flags that "Mark complete" closed automatically (close_reason PROJECT_COMPLETE_CLOSE_PREFIX) were never judged by
 *     anyone, so after a reopen the same request must be raised afresh rather than absorbed by them.
 * A check matches only if its verdict does not need a flag (in_scope / covered_by_co) or a flag exists for it that was
 * not closed by project completion. A flag a person resolved / closed / escalated still absorbs repeats, as before.
 * migration 147 applies the same rule inside guardian_find_duplicate_check.
 */
export const FLAG_REQUIRING_OUTCOMES = new Set(['out_of_scope', 'borderline'])
export function isFlagBackedMatch(
  outcome: string, flags: Array<{ status: string; close_reason?: string | null }>,
): boolean {
  if (!FLAG_REQUIRING_OUTCOMES.has(outcome)) return true
  return flags.some(f => !(f.status === 'closed' && String(f.close_reason ?? '').startsWith(PROJECT_COMPLETE_CLOSE_PREFIX)))
}

export async function findDuplicateCheck(
  service: any, projectId: string, embedding: number[], scopeChangedAt?: string | null,
): Promise<string | null> {
  const literal = `[${embedding.join(',')}]`
  const since = dedupSinceIso(Date.now(), scopeChangedAt)
  const { data, error } = await service.rpc('guardian_find_duplicate_check', {
    p_project_id: projectId,
    p_embedding:  literal,
    p_threshold:  DEDUP_THRESHOLD,
    p_since:      since,
  })
  if (!error) return typeof data === 'string' ? data : null

  console.error('guardian_find_duplicate_check RPC failed — falling back to in-process scan:', error.message)
  const { data: recent } = await service
    .from('guardian_checks')
    .select('id, embedding, outcome')
    .eq('project_id', projectId)
    .eq('is_duplicate', false)
    .not('embedding', 'is', null)
    .neq('outcome', 'pending')
    // Same window as the RPC (migration 144): measured from when the check was judged, so a backlog row classified
    // after the last scope change counts even though it was created before it.
    .or(`classified_at.gte.${since},and(classified_at.is.null,created_at.gte.${since})`)
    .order('created_at', { ascending: false })
    .limit(300)
  const matches: Array<{ id: string; sim: number; outcome: string }> = []
  for (const c of (recent || [])) {
    const sim = cosineSimilarity(embedding, c.embedding)
    if (sim > DEDUP_THRESHOLD) matches.push({ id: c.id, sim, outcome: c.outcome })
  }
  if (matches.length === 0) return null
  matches.sort((a, b) => b.sim - a.sim)

  // Same flag-backing rule as the RPC (migration 147) - see isFlagBackedMatch.
  const needFlag = matches.filter(m => FLAG_REQUIRING_OUTCOMES.has(m.outcome)).map(m => m.id)
  let flagsByCheck = new Map<string, Array<{ status: string; close_reason: string | null }>>()
  if (needFlag.length) {
    const { data: flags, error: flagsErr } = await service
      .from('guardian_flags').select('check_id, status, close_reason').in('check_id', needFlag)
    // Fail toward classifying: with no flag information those matches are simply not usable as duplicates.
    if (flagsErr) console.error('Guardian dedup fallback: flag lookup failed:', flagsErr.message)
    else for (const f of (flags || [])) {
      const list = flagsByCheck.get(f.check_id) || []
      list.push({ status: f.status, close_reason: f.close_reason ?? null })
      flagsByCheck.set(f.check_id, list)
    }
  }
  for (const m of matches) {
    if (isFlagBackedMatch(m.outcome, flagsByCheck.get(m.id) || [])) return m.id
  }
  return null
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
export interface PipelineSnapshot { deliverables?: any[]; out_of_scope?: any[]; last_updated_at?: string | null }

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
      .select('id, title, added_deliverables, removed_deliverables, created_at').eq('project_id', project.id)
      .order('created_at', { ascending: true })
    // An unreadable amendments list must not silently degrade to "no COs" — that
    // would misclassify already-covered work as scope creep.
    if (error) throw new Error(`amendments read failed: ${error.message}`)
    // Only deliverables still live after any later credit/descope CO (see netAmendmentDeliverables).
    // Renames made through scope-adjustment, so an amendment's title and a later credit CO's title (taken from the
    // snapshot) are compared as the same deliverable - see netAmendmentDeliverables.
    const { data: renameRows, error: renameErr } = await service.from('scope_adjustments')
      .select('old_value, new_value, adjusted_at').eq('project_id', project.id).eq('field', 'deliverables')
      .order('adjusted_at', { ascending: true })
    if (renameErr) throw new Error(`scope adjustments read failed: ${renameErr.message}`)
    amendments = netAmendmentDeliverables(data || [], renameRows || [])
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
      // A failed recipient lookup must not skip the bell notification below (it throws on a DB error).
      const emails = await getMemberEmailsWithPermission(
        service, project.workspace_id, 'APPROVE_FLAGS', 25, 'guardian_flag', project.id, p.excludeUserId,
      ).catch((e: unknown) => { console.error('Guardian flag email recipients lookup failed:', e); return [] as string[] })
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
      body: truncateText(classification.reasoning, 140) || (isBorderline
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
  | { status: 'skipped'; reason: 'not_found' | 'not_eligible' | 'no_snapshot' | 'max_attempts' | 'claimed' | 'inactive' | 'paused' }
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
  /**
   * FIX (independent pass 6, section 13 - P1): automatic callers (the guardian-health sweep) must honour a MANUAL pause
   * the same way guardian/inbound does on arrival ("Guardian monitoring stops while it's paused"). A mail queued before
   * the pause (no SOW yet, rate-limited, or classification_failed) was otherwise classified, flagged and emailed to the
   * team while the project was paused. A person pressing Retry is still allowed - they are looking at it.
   */
  skipManualPause?: boolean
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
  const { data: check, error: checkErr } = await q.maybeSingle()
  // FIX (independent pass 8, section 13 - B1): the read errors in this function were never looked at, so an outage
  // answered Retry with "Check not found" (404) / "already being retried" (409) and, in the sweep, was counted as a
  // harmless skip. Only a missing row (or a malformed id, 22P02) is a genuine not-found; anything else throws so the
  // retry route answers 500 and the sweep records the item as failed.
  if (checkErr && checkErr.code !== '22P02') throw new Error(`reclassifyCheck: check read failed: ${checkErr.message}`)
  if (!check) return { status: 'skipped', reason: 'not_found' }

  if (check.is_duplicate || check.outcome !== 'pending') return { status: 'skipped', reason: 'not_eligible' }
  if (opts.requireFailed && !check.classification_failed) return { status: 'skipped', reason: 'not_eligible' }
  const attempts = Number(check.classification_attempts || 0)
  if (attempts >= (opts.maxAttempts ?? Infinity)) return { status: 'skipped', reason: 'max_attempts' }

  const { data: project, error: projectErr } = await service.from('projects')
    .select(`id, name, status, stall_reason, deleted_at, workspace_id, workspaces(id, guardian_sensitivity_tier, deleted_at), project_scope_snapshot(deliverables, out_of_scope, last_updated_at)`)
    .eq('id', check.project_id).eq('workspace_id', check.workspace_id).maybeSingle()
  if (projectErr) throw new Error(`reclassifyCheck: project read failed: ${projectErr.message}`)
  if (!project) return { status: 'skipped', reason: 'not_found' }
  // Same gates as live submission: nothing is classified, flagged or emailed for a deleted project,
  // a Complete/Archived one, or a suspended/deleted workspace. Checked BEFORE the claim so no
  // attempt is burned and no AI usage recorded.
  if (project.deleted_at || !project.workspaces || project.workspaces.deleted_at || ['Complete', 'Archived'].includes(project.status))
    return { status: 'skipped', reason: 'inactive' }
  if (opts.skipManualPause && project.status === 'Stalled' && project.stall_reason === 'manual')
    return { status: 'skipped', reason: 'paused' }
  const snapshot = project.project_scope_snapshot
  if (!snapshot) return { status: 'skipped', reason: 'no_snapshot' }

  // Compare-and-swap claim: two concurrent retries/sweeps both read attempts=N;
  // only one can move it to N+1, the other backs off (previously both classified
  // and both raised a flag).
  const { data: claimed, error: claimErr } = await service.from('guardian_checks')
    .update({ classification_attempts: attempts + 1, last_attempt_at: new Date().toISOString() })
    .eq('id', check.id).eq('classification_attempts', attempts).eq('outcome', 'pending')
    .select('id')
  // A failed claim write is not a lost race: reporting it as `claimed` told the user someone else was already retrying.
  if (claimErr) throw new Error(`reclassifyCheck: claim failed: ${claimErr.message}`)
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
    const duplicateOfId = await findDuplicateCheck(service, check.project_id, embedding, snapshot.last_updated_at)
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
