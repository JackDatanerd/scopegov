export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { classifyGuardianCheck, resolveMatchedAmendmentId, type Sensitivity } from '@/lib/ai/guardian'
import { sendGuardianFlagEmail } from '@/lib/email/templates'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'
import { notifyMembersWithPermission } from '@/lib/utils/notify'
import { canReadProject } from '@/lib/utils/project-access'
import { checkAiRateLimit, recordAiUsage } from '@/lib/utils/rate-limit'

// FEATURE (deep audit, section 13 — feature gap): cron/guardian-health pages ops
// the moment classification_failed checks pile up unresolved past 24h, but until
// now nothing anywhere could actually act on that alert. A paste-sourced check
// could be informally "retried" by resubmitting the exact same content — the
// dedup fix a few audit rounds back explicitly excludes classification_failed
// checks from dedup matching so a resubmission goes through fresh — but an
// email-sourced check from the inbound webhook has no submitter, no session,
// and no form to resubmit through, so it just sat there forever with no path
// to ever get classified. This re-runs classification in place against the
// check's own already-stored content, rather than requiring a brand new
// submission, and is available for either source.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: checkId } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'SUBMIT_GUARDIAN_CHECKS'))
      return NextResponse.json({ error: 'Missing permission: SUBMIT_GUARDIAN_CHECKS' }, { status: 403 })

    const service = createServiceClient()

    const { data: check, error: checkErr } = await (service as any)
      .from('guardian_checks')
      .select('id, project_id, content, classification_failed')
      .eq('id', checkId)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (checkErr || !check) return NextResponse.json({ error: 'Check not found' }, { status: 404 })
    if (!(await canReadProject(service, session, check.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Only the one state this route exists for — not a general "re-classify
    // anything on demand" endpoint. A check that already reached a real
    // verdict (or is a still-pending duplicate) has nothing broken to fix.
    if (!check.classification_failed)
      return NextResponse.json({ error: 'Only a classification_failed check can be retried' }, { status: 400 })

    const limited = await checkAiRateLimit(service, session.id, 'guardian.check')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })

    const { data: project } = await (service as any)
      .from('projects')
      .select(`id, name, workspace_id,
        workspaces(id, guardian_sensitivity_tier),
        project_scope_snapshot(deliverables, out_of_scope)`)
      .eq('id', check.project_id)
      .eq('workspace_id', session.workspaceId)
      .single()
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const snapshot = project.project_scope_snapshot
    if (!snapshot)
      return NextResponse.json({ error: 'No signed SOW to classify against yet' }, { status: 400 })
    const sensitivity = (project.workspaces?.guardian_sensitivity_tier || 'medium') as Sensitivity

    const { data: amendments } = await (service as any)
      .from('amendments').select('id, title, added_deliverables').eq('project_id', project.id)

    await recordAiUsage(service, session.workspaceId, session.id, 'guardian.check')

    let classification
    try {
      classification = await classifyGuardianCheck({
        content: check.content,
        snapshot: { deliverables: snapshot.deliverables || [], outOfScope: snapshot.out_of_scope || [] },
        amendments: amendments || [],
        sensitivity,
      })
    } catch (classErr) {
      console.error('Guardian retry classification failed:', classErr)
      // Leave classification_failed:true as-is — this attempt didn't change
      // anything, so the check stays exactly as retryable as it was before.
      return NextResponse.json({ error: 'Classification failed again — try again shortly' }, { status: 502 })
    }

    const matchedAmendmentId = resolveMatchedAmendmentId(
      amendments || [], classification.matchedAgainst, classification.matchedReference,
    )

    await (service as any).from('guardian_checks').update({
      match_confidence:      classification.matchConfidence,
      creep_confidence:      classification.creepConfidence,
      matched_against:       classification.matchedAgainst,
      matched_reference:     classification.matchedReference,
      matched_amendment_id:  matchedAmendmentId,
      outcome:               classification.outcome,
      classified_at:         new Date().toISOString(),
      classification_failed: false,
    }).eq('id', checkId)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'check.retried', entityType: 'guardian_check',
      entityId: checkId, entityName: project.name,
      metadata: { outcome: classification.outcome, creep_confidence: classification.creepConfidence },
    })

    // ── Create flag if out_of_scope OR borderline — mirrors STEP 6 of
    // api/guardian/check (see that route for the full reasoning). ─────
    let flagId: string | null = null
    if (classification.outcome === 'out_of_scope' || classification.outcome === 'borderline') {
      const isBorderline = classification.outcome === 'borderline'
      const severity = isBorderline ? 'info' : (
        classification.creepConfidence >= 0.90 ? 'high'
        : classification.creepConfidence >= 0.75 ? 'medium' : 'low'
      )

      const { data: flag } = await (service as any).from('guardian_flags').insert({
        project_id:    project.id,
        workspace_id:  session.workspaceId,
        check_id:      checkId,
        type:          'scope_creep',
        severity,
        description:   classification.reasoning,
        sow_reference: classification.matchedReference || 'General scope',
        status:        isBorderline ? 'borderline_review' : 'open',
      }).select('id').single()

      if (flag) {
        flagId = flag.id
        await (service as any).from('guardian_checks').update({ flag_id: flagId }).eq('id', checkId)

        await logAudit(service, {
          workspaceId: session.workspaceId, actorId: session.id,
          actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
          eventType: isBorderline ? 'flag.borderline_created' : 'flag.raised', entityType: 'guardian_flag',
          entityId: flagId ?? undefined, entityName: project.name,
          metadata: { severity, creep_confidence: classification.creepConfidence },
        })

        if (!isBorderline) {
          const emails = await getMemberEmailsWithPermission(service, session.workspaceId, 'APPROVE_FLAGS', 25, 'guardian_flag', project.id)
          if (emails.length) {
            try {
              await sendGuardianFlagEmail({
                to:           emails,
                projectName:  project.name,
                severity,
                description:  classification.reasoning,
                sowReference: classification.matchedReference || 'General scope',
                projectUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=guardian`,
                path:         'retry',
              })
            } catch (emailErr) {
              console.error('Guardian flag email failed:', emailErr)
            }
          }
        }
        await notifyMembersWithPermission(service, {
          workspaceId: session.workspaceId, permission: 'APPROVE_FLAGS', eventType: 'guardian_flag',
          type: 'guardian_flag',
          title: isBorderline ? `Borderline scope item — ${project.name}` : `Scope flag — ${project.name}`,
          body: classification.reasoning?.slice(0, 140) || (isBorderline
            ? 'A possible scope item needs a quick look.'
            : 'A new out-of-scope request was flagged.'),
          entityType: 'project', entityId: project.id, excludeUserId: session.id, projectId: project.id,
        })
      }
    }

    return NextResponse.json({
      checkId,
      outcome:          classification.outcome,
      matchConfidence:  classification.matchConfidence,
      creepConfidence:  classification.creepConfidence,
      matchedReference: classification.matchedReference,
      flagId,
    })
  } catch (err) {
    console.error('Guardian check retry error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
