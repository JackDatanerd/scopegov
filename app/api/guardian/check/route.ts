export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { MAX_CHECK_CONTENT_CHARS, type Sensitivity } from '@/lib/ai/guardian'
import { classifyAndRecord, findDuplicateCheck, tryEmbedding } from '@/lib/ai/guardian-pipeline'
import { canReadProject } from '@/lib/utils/project-access'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'

const SOURCES = ['email', 'paste', 'slack', 'webhook']

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SUBMIT_GUARDIAN_CHECKS'))
      return NextResponse.json({ error: 'Missing permission: SUBMIT_GUARDIAN_CHECKS' }, { status: 403 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    const { projectId, content, source = 'paste' } = body || {}
    const isRetroactive = body?.isRetroactive === true

    // FIX (independent pass, section 13): `content` was only truthiness/`.trim()`-checked, so a
    // non-string (number/array/object) threw a TypeError → 500, and there was no upper bound at
    // all — an arbitrarily large paste was stored verbatim and sent to the classifier.
    if (typeof projectId !== 'string' || !projectId || typeof content !== 'string' || !content.trim())
      return NextResponse.json({ error: 'projectId and content required' }, { status: 400 })
    if (content.length > MAX_CHECK_CONTENT_CHARS)
      return NextResponse.json({
        error: `Content is too long (${content.length.toLocaleString()} characters). Paste at most ${MAX_CHECK_CONTENT_CHARS.toLocaleString()} — the request itself, not the whole thread.`,
      }, { status: 413 })
    // `source` is validated against the DB CHECK up front so a bad value can't burn an embedding call.
    if (typeof source !== 'string' || !SOURCES.includes(source))
      return NextResponse.json({ error: `Invalid source: ${String(source).slice(0, 40)}` }, { status: 400 })

    const service = createServiceClient()

    const { data: project, error: projectErr } = await (service as any)
      .from('projects')
      .select(`id, name, status, workspace_id,
        workspaces(id, guardian_sensitivity_tier),
        project_scope_snapshot(deliverables, out_of_scope)`)
      .eq('id', projectId)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (projectErr) console.error('Guardian check: project fetch failed', projectErr)
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    if (!['Active','Stalled'].includes(project.status) && !isRetroactive)
      return NextResponse.json({ error: 'Guardian only active on Active projects' }, { status: 400 })

    const limited = await checkAiRateLimit(service, session.id, 'guardian.check')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    // project_scope_snapshot.project_id is UNIQUE → one-to-one, PostgREST returns an object.
    const snapshot    = project.project_scope_snapshot
    const sensitivity = (project.workspaces?.guardian_sensitivity_tier || 'medium') as Sensitivity
    const actor = { id: session.id, email: session.email, name: session.name, ip: getClientIp(request) }

    // ── No signed SOW yet: store the check, spend NOTHING ─────
    // (Previously an embedding was computed and usage recorded before this was even known.)
    // The stored row is re-classified automatically by the guardian-health sweep once the
    // SOW is signed — it used to sit `pending` forever.
    if (!snapshot) {
      const { data: pendingRow, error: pendingErr } = await (service as any).from('guardian_checks').insert({
        project_id: projectId, workspace_id: session.workspaceId, content, source,
        submitted_by: session.id, submitted_at: new Date().toISOString(),
        is_retroactive: isRetroactive, is_duplicate: false, outcome: 'pending',
      }).select('id').single()
      if (pendingErr || !pendingRow) throw new Error(pendingErr?.message || 'Could not store check')
      return NextResponse.json({
        checkId: pendingRow.id, outcome: 'pending',
        message: 'Guardian not yet active — no signed SOW. This request is saved and will be checked automatically once the SOW is signed.',
      })
    }

    // ── STEP 1: embedding (always — BUG-060) ──────────────────
    const embedding = await tryEmbedding(content)
    // Usage is recorded as soon as a real paid attempt was made (not only on full success).
    await recordAiUsage(service, session.workspaceId, session.id, 'guardian.check')

    // ── STEP 2: dedup (pgvector, cosine > 0.85, 30 days) ──────
    const duplicateOfId = embedding ? await findDuplicateCheck(service, projectId, embedding) : null
    const isDuplicate = !!duplicateOfId

    // ── STEP 3: write the check row ───────────────────────────
    const { data: checkRow, error: checkErr } = await (service as any)
      .from('guardian_checks')
      .insert({
        project_id: projectId, workspace_id: session.workspaceId, content, source,
        submitted_by: session.id, submitted_at: new Date().toISOString(),
        is_retroactive: isRetroactive, is_duplicate: isDuplicate, duplicate_of_id: duplicateOfId,
        embedding: isDuplicate ? null : embedding, // BUG-060: only persist for non-duplicates
        outcome: 'pending',
      })
      .select('id').single()
    if (checkErr || !checkRow) throw new Error(checkErr?.message || 'Could not store check')

    if (isDuplicate) {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
        eventType: 'check.duplicate_skipped', entityType: 'guardian_check',
        entityId: checkRow.id, entityName: project.name,
        metadata: { duplicate_of: duplicateOfId },
      })
      return NextResponse.json({ checkId: checkRow.id, outcome: 'duplicate', isDuplicate: true, duplicateOfId })
    }

    // ── STEP 4-6: classify → record → flag ────────────────────
    const res = await classifyAndRecord(service, {
      check: { id: checkRow.id, content },
      project: { id: project.id, name: project.name, workspace_id: project.workspace_id },
      snapshot, sensitivity, actor,
      auditEvent: 'check.classified', emailPath: source,
      flagMeta: { source }, excludeUserId: session.id,
    })

    if (res.status === 'failed') {
      return NextResponse.json({
        checkId: checkRow.id, outcome: 'classification_failed', classificationFailed: true,
        message: res.reason === 'flag'
          ? 'The verdict was reached but the flag could not be saved. The check is queued for automatic retry.'
          : undefined,
      })
    }

    const { classification, flagId } = res
    return NextResponse.json({
      checkId:          checkRow.id,
      outcome:          classification.outcome,
      matchConfidence:  classification.matchConfidence,
      creepConfidence:  classification.creepConfidence,
      matchedReference: classification.matchedReference,
      flagId,
    })
  } catch (err) {
    console.error('Guardian check error:', err)
    return NextResponse.json({ error: 'Guardian check failed — please try again.' }, { status: 500 })
  }
}
