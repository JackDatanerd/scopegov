export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { getClientIp } from '@/lib/utils/request-ip'
import { reclassifyCheck } from '@/lib/ai/guardian-pipeline'
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
      .select('id, project_id, classification_failed')
      .eq('id', checkId)
      .eq('workspace_id', session.workspaceId)
      .single()

    if (checkErr || !check) return NextResponse.json({ error: 'Check not found' }, { status: 404 })
    if (!(await canReadProject(service, session, check.project_id)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Only the one state this route exists for — not a general "re-classify anything" endpoint.
    if (!check.classification_failed)
      return NextResponse.json({ error: 'Only a classification_failed check can be retried' }, { status: 400 })

    const limited = await checkAiRateLimit(service, session.id, 'guardian.check')
    if (!limited.allowed) return NextResponse.json({ error: limited.message }, { status: 429 })
    await recordAiUsage(service, session.workspaceId, session.id, 'guardian.check')

    // reclassifyCheck claims the row with a compare-and-swap, so two concurrent retries
    // (double click, two tabs) can no longer both classify and both raise a flag.
    const res = await reclassifyCheck(service, checkId, {
      workspaceId: session.workspaceId,
      actor: { id: session.id, email: session.email, name: session.name, ip: getClientIp(request) },
      auditEvent: 'check.retried', emailPath: 'retry',
      requireFailed: true, excludeUserId: session.id,
    })

    if (res.status === 'skipped') {
      if (res.reason === 'no_snapshot') return NextResponse.json({ error: 'No signed SOW to classify against yet' }, { status: 400 })
      if (res.reason === 'claimed') return NextResponse.json({ error: 'This check is already being retried — refresh in a moment.' }, { status: 409 })
      if (res.reason === 'not_found') return NextResponse.json({ error: 'Check not found' }, { status: 404 })
      return NextResponse.json({ error: 'Only a classification_failed check can be retried' }, { status: 400 })
    }
    if (res.status === 'failed') {
      // Stays classification_failed:true — exactly as retryable as before.
      return NextResponse.json({ error: 'Classification failed again — try again shortly' }, { status: 502 })
    }

    const { classification, flagId } = res
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
    return NextResponse.json({ error: 'Retry failed — please try again.' }, { status: 500 })
  }
}
