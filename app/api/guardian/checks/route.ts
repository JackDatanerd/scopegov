// app/api/guardian/checks/route.ts
//
// FEATURE (deep audit, section 13 — flagship finding): ACCESS_GUARDIAN_HISTORY
// has existed as a permission since 001_initial_schema.sql and is seeded into
// every role's default permission set — but nothing ever read it, and no
// endpoint ever existed to serve what it's supposed to gate. Every
// guardian_checks row that doesn't produce a flag (in_scope, covered_by_co,
// duplicate, pending, classification_failed) was permanently invisible in
// the product, visible only via a direct DB query. This is the missing
// read surface: a paginated history of every check run against a project,
// regardless of outcome.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { canReadProject } from '@/lib/utils/project-access'

const PAGE_SIZE = 30

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'ACCESS_GUARDIAN_HISTORY'))
      return NextResponse.json({ error: 'Missing permission: ACCESS_GUARDIAN_HISTORY' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId')
    const before     = searchParams.get('before') // ISO timestamp cursor — created_at of the last row already loaded
    if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 })

    const service = createServiceClient()

    // Scope to workspace before anything else — same pattern as every
    // other Guardian route (check, scope-adjustment).
    const { data: project } = await (service as any)
      .from('projects').select('id').eq('id', projectId).eq('workspace_id', session.workspaceId).single()
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    if (!(await canReadProject(service, session, projectId)))
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    let query = (service as any)
      .from('guardian_checks')
      .select(`
        id, source, source_metadata, submitted_by, submitted_at, is_retroactive,
        is_duplicate, duplicate_of_id, match_confidence, creep_confidence,
        matched_against, matched_reference, outcome, classified_at,
        classification_failed, flag_id, content, created_at,
        users!guardian_checks_submitted_by_fkey(name)
      `)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE)

    if (before) query = query.lt('created_at', before)

    const { data: checks, error } = await query
    if (error) throw new Error(error.message)

    const rows = checks || []

    return NextResponse.json({
      checks: rows.map((c: any) => ({
        id:                 c.id,
        source:             c.source,
        fromEmail:          c.source_metadata?.from || null,
        submittedByName:    c.users?.name || (c.source === 'email' ? null : 'Unknown'),
        submittedAt:        c.submitted_at,
        isRetroactive:      c.is_retroactive,
        isDuplicate:        c.is_duplicate,
        duplicateOfId:      c.duplicate_of_id,
        matchConfidence:    c.match_confidence,
        creepConfidence:    c.creep_confidence,
        matchedAgainst:     c.matched_against,
        matchedReference:   c.matched_reference,
        outcome:            c.outcome,
        classificationFailed: c.classification_failed,
        flagId:             c.flag_id,
        // Preview only — the full submitted content isn't needed for a
        // scan-the-history view, and keeps the payload light.
        contentPreview:     (c.content || '').slice(0, 240),
        createdAt:          c.created_at,
      })),
      // A page short of PAGE_SIZE means there's nothing older left.
      hasMore: rows.length === PAGE_SIZE,
      nextCursor: rows.length ? rows[rows.length - 1].created_at : null,
    })
  } catch (err) {
    console.error('Guardian check history error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
