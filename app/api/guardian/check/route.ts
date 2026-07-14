export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { stripHtml } from '@/lib/utils/format'
import {
  classifyGuardianCheck, getEmbedding, cosineSimilarity,
  type Sensitivity,
} from '@/lib/ai/guardian'
import { sendGuardianFlagEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SUBMIT_GUARDIAN_CHECKS'))
      return NextResponse.json({ error: 'Missing permission: SUBMIT_GUARDIAN_CHECKS' }, { status: 403 })

    const { projectId, content, source = 'paste', isRetroactive = false } = await request.json()
    if (!projectId || !content?.trim())
      return NextResponse.json({ error: 'projectId and content required' }, { status: 400 })

    const service = createServiceClient()

    // Fetch project + snapshot + workspace settings
    const { data: project } = await (service as any)
      .from('projects')
      .select(`id, name, status, workspace_id,
        workspaces(id, guardian_sensitivity_tier),
        project_scope_snapshot(deliverables, out_of_scope)`)
      .eq('id', projectId)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!['Active','Stalled'].includes(project.status) && !isRetroactive)
      return NextResponse.json({ error: 'Guardian only active on Active projects' }, { status: 400 })

    // FIX: project_scope_snapshot.project_id is UNIQUE, so this is a
    // one-to-one relation — PostgREST returns a single object, not an
    // array. Indexing [0] on it always returned undefined, which is why
    // Guardian checks always reported "no signed SOW" even when signed.
    const snapshot    = project.project_scope_snapshot
    const sensitivity = (project.workspaces?.guardian_sensitivity_tier || 'medium') as Sensitivity

    // ── STEP 1: Compute embedding (always — BUG-060) ──────────
    const textForEmbed = stripHtml(content).slice(0, 500) // spec §1.6.4
    let embedding: number[] | null = null
    try {
      embedding = await getEmbedding(textForEmbed)
    } catch (embErr) {
      console.error('Embedding failed:', embErr)
      // Non-fatal — dedup skipped if embedding fails
    }

    // ── STEP 2: Dedup check (cosine similarity > 0.85) ────────
    let isDuplicate    = false
    let duplicateOfId: string | null = null

    if (embedding) {
      const { data: recentChecks } = await (service as any)
        .from('guardian_checks')
        .select('id, embedding')
        .eq('project_id', projectId)
        .eq('is_duplicate', false)
        .not('embedding', 'is', null)
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        .limit(100)

      for (const check of (recentChecks || [])) {
        if (!check.embedding) continue
        const sim = cosineSimilarity(embedding, check.embedding)
        if (sim > 0.85) {
          isDuplicate   = true
          duplicateOfId = check.id
          break
        }
      }
    }

    // ── STEP 3: Write guardian_check row ──────────────────────
    const { data: checkRow, error: checkErr } = await (service as any)
      .from('guardian_checks')
      .insert({
        project_id:     projectId,
        workspace_id:   session.workspaceId,
        content,
        source,
        submitted_by:   session.id,
        submitted_at:   new Date().toISOString(),
        is_retroactive: isRetroactive,
        is_duplicate:   isDuplicate,
        duplicate_of_id: duplicateOfId,
        // BUG-060: only persist embedding for non-duplicates
        embedding:      isDuplicate ? null : embedding,
        outcome:        'pending',
      })
      .select('id').single()

    if (checkErr) throw new Error(checkErr.message)

    if (isDuplicate) {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'check.duplicate_skipped', entityType: 'guardian_check',
        entityId: checkRow.id, entityName: project.name,
        metadata: { duplicate_of: duplicateOfId },
      })
      return NextResponse.json({ checkId: checkRow.id, outcome: 'duplicate', isDuplicate: true })
    }

    // ── STEP 4: Classification ────────────────────────────────
    if (!snapshot) {
      await (service as any).from('guardian_checks')
        .update({ outcome: 'pending', classification_failed: false }).eq('id', checkRow.id)
      return NextResponse.json({ checkId: checkRow.id, outcome: 'pending', message: 'Guardian not yet active — no signed SOW' })
    }

    // Fetch accepted amendments for CO coverage check
    const { data: amendments } = await (service as any)
      .from('amendments')
      .select('id, title, added_deliverables')
      .eq('project_id', projectId)

    let classification
    let classificationFailed = false
    try {
      classification = await classifyGuardianCheck({
        content,
        snapshot: {
          deliverables: snapshot.deliverables || [],
          outOfScope:   snapshot.out_of_scope || [],
        },
        amendments:  amendments || [],
        sensitivity,
      })
    } catch (classErr) {
      console.error('Classification failed:', classErr)
      classificationFailed = true
    }

    if (classificationFailed || !classification) {
      await (service as any).from('guardian_checks')
        .update({ classification_failed: true, outcome: 'pending' }).eq('id', checkRow.id)
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'check.classification_failed', entityType: 'guardian_check',
        entityId: checkRow.id, entityName: project.name, metadata: {},
      })
      return NextResponse.json({ checkId: checkRow.id, outcome: 'classification_failed', classificationFailed: true })
    }

    // ── STEP 5: Update check with results ─────────────────────
    await (service as any).from('guardian_checks').update({
      match_confidence:    classification.matchConfidence,
      creep_confidence:    classification.creepConfidence,
      matched_against:     classification.matchedAgainst,
      matched_reference:   classification.matchedReference,
      outcome:             classification.outcome,
      classified_at:       new Date().toISOString(),
      classification_failed: false,
    }).eq('id', checkRow.id)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name,
      eventType: 'check.classified', entityType: 'guardian_check',
      entityId: checkRow.id, entityName: project.name,
      metadata: { outcome: classification.outcome, creep_confidence: classification.creepConfidence },
    })

    // ── STEP 6: Create flag if out_of_scope ───────────────────
    let flagId: string | null = null
    if (classification.outcome === 'out_of_scope') {
      const severity = classification.creepConfidence >= 0.90 ? 'high'
        : classification.creepConfidence >= 0.75 ? 'medium' : 'low'

      const { data: flag } = await (service as any).from('guardian_flags').insert({
        project_id:    projectId,
        workspace_id:  session.workspaceId,
        check_id:      checkRow.id,
        type:          'scope_creep',
        severity,
        description:   classification.reasoning,
        sow_reference: classification.matchedReference || 'General scope',
        status:        'open',
      }).select('id').single()

      if (flag) {
        flagId = flag.id
        await (service as any).from('guardian_checks').update({ flag_id: flagId }).eq('id', checkRow.id)

        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name,
          eventType: 'flag.raised', entityType: 'guardian_flag',
          // FIX: logAudit's entityId is `string | undefined`; flagId is `string | null`
          // (declared type wins over `any`-typed flag.id during narrowing). Coerce here.
          entityId: flagId ?? undefined, entityName: project.name,
          metadata: { severity, creep_confidence: classification.creepConfidence },
        })

        // Email APPROVE_FLAGS holders (Event 18)
        const emails = await getMemberEmailsWithPermission(service, session.workspaceId, 'APPROVE_FLAGS', 25, 'guardian_flag')

        if (emails.length) {
          try {
            await sendGuardianFlagEmail({
              to:           emails,
              agencyName:   project.workspaces?.agency_name || '',
              projectName:  project.name,
              severity,
              description:  classification.reasoning,
              sowReference: classification.matchedReference || 'General scope',
              projectUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/projects/${projectId}?tab=guardian`,
              path:         source,
            })
          } catch (emailErr) {
            console.error('Guardian flag email failed:', emailErr)
          }
        }
        await notifyMembersWithPermission(service, {
          workspaceId: session.workspaceId, permission: 'APPROVE_FLAGS', eventType: 'guardian_flag',
          type: 'guardian_flag', title: `Scope flag — ${project.name}`,
          body: classification.reasoning?.slice(0, 140) || 'A new out-of-scope request was flagged.',
          entityType: 'project', entityId: projectId, excludeUserId: session.id,
        })
      }
    }

    return NextResponse.json({
      checkId:         checkRow.id,
      outcome:         classification.outcome,
      matchConfidence: classification.matchConfidence,
      creepConfidence: classification.creepConfidence,
      matchedReference: classification.matchedReference,
      flagId,
    })
  } catch (err) {
    console.error('Guardian check error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
