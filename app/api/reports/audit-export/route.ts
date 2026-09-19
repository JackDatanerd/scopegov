export const runtime = 'nodejs'
export const maxDuration = 60

import { NextResponse } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { renderAuditReportPdf, type AuditReportRow } from '@/lib/pdf/audit-report'
import { csvRow, CSV_BOM } from '@/lib/utils/csv'
import { fetchPaged } from '@/lib/utils/paginate'
import { buildAuditSearchFilter } from '@/lib/audit/search'
import { AUDIT_CATEGORIES, categoryFilter } from '@/lib/audit/categories'
import { redactMetadata } from '@/lib/audit/redact'

// GET /api/reports/audit-export
//   ?format=json|csv|pdf   (default json — powers the filtered table view)
//   &from=ISO|yyyy-mm-dd   &to=ISO|yyyy-mm-dd   (default: last 90 days)
//   &projectId=uuid
//   &actorId=uuid|none     ("none" = events with no signed-in user: client
//                           portal actions, crons, automated system events)
//   &category=<AUDIT_CATEGORIES id>
//   &q=free text over event / record name / actor name / actor email / IP
//   &offset=N&asOf=ISO     (format=json paging — see below)
//
// Gated by VIEW_AUDIT_LOG — the same permission that already gates viewing
// the audit log itself. Exporting is a stricter form of the same read, not
// a separate capability, so it doesn't need its own permission.

const MAX_ROWS_CSV = 25000
const MAX_ROWS_PDF = 1000
// In-app paging ceiling; CSV/PDF remain the tool for anything beyond it.
const MAX_ROWS_JSON = 2000
const PAGE_SIZE_JSON = 100

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const SELECT_COLUMNS =
  'id, event_type, entity_type, entity_id, entity_name, actor_name, actor_email, actor_id, project_id, created_at, metadata, ip_address'

// FIX (Reports & Audit re-pass #3): a bare yyyy-mm-dd is now interpreted as a
// UTC day explicitly (the old code used setHours() — server-local time — on
// top of a UTC-parsed date). The in-app UI sends full ISO instants built from
// the viewer's LOCAL day, so a Nairobi user's "Sep 19" is Sep 19 in Nairobi;
// bare dates remain supported for direct API callers.
function parseBound(raw: string | null, kind: 'from' | 'to'): Date | null | undefined {
  if (!raw) return undefined
  if (BARE_DATE_RE.test(raw)) {
    return new Date(`${raw}T${kind === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`)
  }
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d
}

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_AUDIT_LOG')) {
      return NextResponse.json({ error: 'Missing permission: VIEW_AUDIT_LOG' }, { status: 403 })
    }
    // VIEW_AUDIT_LOG and VIEW_FINANCIALS are independent toggles on a custom
    // role, so audit access without financial visibility is realistic —
    // dollar figures are redacted out of metadata for those viewers.
    const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')

    const url = new URL(request.url)
    const sp = url.searchParams

    const formatRaw = sp.get('format') || 'json'
    if (formatRaw !== 'json' && formatRaw !== 'csv' && formatRaw !== 'pdf') {
      return NextResponse.json({ error: 'Unsupported format' }, { status: 400 })
    }
    const format = formatRaw as 'json' | 'csv' | 'pdf'

    const projectId = sp.get('projectId') || undefined
    if (projectId && !UUID_RE.test(projectId)) {
      return NextResponse.json({ error: 'Invalid projectId' }, { status: 400 })
    }
    const actorParam = sp.get('actorId') || undefined
    if (actorParam && actorParam !== 'none' && !UUID_RE.test(actorParam)) {
      return NextResponse.json({ error: 'Invalid actorId' }, { status: 400 })
    }
    const category = sp.get('category') || undefined
    if (category && !AUDIT_CATEGORIES.some(c => c.id === category)) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 })
    }
    const q = (sp.get('q') || '').trim().slice(0, 100)
    const offset = Math.max(0, Math.min(parseInt(sp.get('offset') || '0', 10) || 0, MAX_ROWS_JSON))

    const now = new Date()
    const from = parseBound(sp.get('from'), 'from')
    const to = parseBound(sp.get('to'), 'to')
    if (from === null || to === null) {
      return NextResponse.json({ error: 'Invalid date range' }, { status: 400 })
    }
    const fromDate = from ?? new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    const toDate = to ?? now
    if (fromDate.getTime() > toDate.getTime()) {
      return NextResponse.json({ error: '"from" must be on or before "to"' }, { status: 400 })
    }

    // FIX (Reports & Audit re-pass #3): paging is pinned to a snapshot
    // instant. Without it, events written between "page 1" and "Load more"
    // shifted every later row down by however many arrived and produced
    // duplicated rows across pages. The first response returns `asOf`; the
    // client sends it back on every later page.
    let upper = toDate
    const asOfRaw = sp.get('asOf')
    if (format === 'json' && asOfRaw) {
      const asOf = new Date(asOfRaw)
      if (!isNaN(asOf.getTime()) && asOf.getTime() < upper.getTime()) upper = asOf
    }
    const asOfOut = format === 'json' ? (asOfRaw && !isNaN(new Date(asOfRaw).getTime()) ? new Date(asOfRaw) : now).toISOString() : undefined

    const service = createServiceClient()

    let projectName: string | undefined
    if (projectId) {
      // Deleted (soft or purged) projects are still valid filters — "what
      // happened on that project" is exactly the question an audit answers.
      const { data: proj, error: projErr } = await (service as any)
        .from('projects').select('id, name').eq('id', projectId).eq('workspace_id', session.workspaceId).maybeSingle()
      if (projErr) throw new Error(`project lookup: ${projErr.message}`)
      // A purged project no longer has a row, but audit rows can still carry
      // its id. Only 404 when the id has never appeared in this workspace's log.
      if (!proj) {
        const { count: seen, error: seenErr } = await (service as any)
          .from('audit_log').select('id', { count: 'exact', head: true })
          .eq('workspace_id', session.workspaceId).eq('project_id', projectId)
        if (seenErr) throw new Error(`project lookup: ${seenErr.message}`)
        if (!seen) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      } else {
        projectName = proj.name
      }
    }

    let actorName: string | undefined
    if (actorParam === 'none') {
      actorName = 'System / client portal (no signed-in user)'
    } else if (actorParam) {
      // Scoped through workspace_members so a foreign user's name can never
      // be pulled into this workspace's export header.
      const { data: member, error: memberErr } = await (service as any)
        .from('workspace_members').select('users(name)')
        .eq('workspace_id', session.workspaceId).eq('user_id', actorParam).maybeSingle()
      if (memberErr) throw new Error(`actor lookup: ${memberErr.message}`)
      actorName = member?.users?.name
    }

    const searchFilter = buildAuditSearchFilter(q)
    const categoryOr = categoryFilter(category)

    const buildQuery = () => {
      let query = (service as any)
        .from('audit_log')
        .select(SELECT_COLUMNS, { count: 'exact' })
        .eq('workspace_id', session.workspaceId)
        .gte('created_at', fromDate.toISOString())
        .lte('created_at', upper.toISOString())
        // Deterministic order: rows that share a created_at (several events
        // written in one transaction) are ordered by id so offset paging can
        // never duplicate or skip them.
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
      if (actorParam === 'none') query = query.is('actor_id', null)
      else if (actorParam) query = query.eq('actor_id', actorParam)
      if (projectId) query = query.eq('project_id', projectId)
      if (categoryOr) query = query.or(categoryOr)
      if (searchFilter) query = query.or(searchFilter)
      return query
    }

    let pageRows: any[]
    let totalCount: number
    let truncated: boolean
    let hasMore = false

    if (format === 'json') {
      const end = Math.min(offset + PAGE_SIZE_JSON, MAX_ROWS_JSON) - 1
      // range(offset, end) with offset > end (offset already at the ceiling)
      // is a valid "no rows" request, so short-circuit instead.
      if (offset > end) {
        const { count, error } = await buildQuery().range(0, 0)
        if (error) throw new Error(error.message)
        pageRows = []
        totalCount = count ?? 0
      } else {
        const { data, error, count } = await buildQuery().range(offset, end)
        if (error) throw new Error(error.message)
        pageRows = data || []
        totalCount = count ?? pageRows.length
      }
      truncated = totalCount > MAX_ROWS_JSON
      hasMore = offset + pageRows.length < Math.min(totalCount, MAX_ROWS_JSON)
    } else {
      const maxRows = format === 'csv' ? MAX_ROWS_CSV : MAX_ROWS_PDF
      const res = await fetchPaged<any>((f, t) => buildQuery().range(f, t), { maxRows })
      pageRows = res.rows
      totalCount = res.total
      truncated = res.truncated
    }

    if (format === 'json') {
      return NextResponse.json({
        rows: pageRows.map(r => ({
          id: r.id, eventType: r.event_type, entityType: r.entity_type, entityId: r.entity_id, entityName: r.entity_name,
          actorId: r.actor_id, actorName: r.actor_name, actorEmail: r.actor_email,
          projectId: r.project_id, createdAt: r.created_at, ipAddress: r.ip_address,
          metadata: redactMetadata(r.metadata, canViewFinancials),
        })),
        totalCount, truncated, hasMore, offset, nextOffset: offset + pageRows.length, asOf: asOfOut,
      })
    }

    let body: Uint8Array
    let contentType: string
    let filename: string

    if (format === 'csv') {
      const csv = toCsv(pageRows, canViewFinancials, truncated, totalCount)
      body = new Uint8Array(Buffer.from(CSV_BOM + csv, 'utf-8'))
      contentType = 'text/csv; charset=utf-8'
      filename = exportFilename(session.workspaceName, fromDate, upper, 'csv')
    } else {
      const pdfRows: AuditReportRow[] = pageRows.map(r => ({
        createdAt: r.created_at, eventType: r.event_type, actorName: r.actor_name || 'System',
        actorEmail: r.actor_email, entityType: r.entity_type, entityName: r.entity_name || '', ipAddress: r.ip_address,
      }))
      const buffer = await renderAuditReportPdf({
        agencyName: session.agencyName, workspaceName: session.workspaceName,
        generatedBy: session.name, generatedAt: new Date().toISOString(),
        from: fromDate.toISOString(), to: upper.toISOString(),
        filters: {
          project: projectName ?? (projectId ? 'Deleted project' : undefined),
          actor: actorName,
          category: category ? AUDIT_CATEGORIES.find(c => c.id === category)?.label : undefined,
          search: q || undefined,
        },
        totalCount, truncated, rows: pdfRows,
      })
      body = new Uint8Array(buffer)
      contentType = 'application/pdf'
      filename = exportFilename(session.workspaceName, fromDate, upper, 'pdf')
    }

    // Log the export itself — but only once the file has actually been
    // produced (a failed PDF render used to be recorded as a successful
    // export). Who pulled the audit trail, with which filters, is exactly
    // what a compliance trail should capture about itself.
    await logAudit(service, {
      workspaceId: session.workspaceId,
      actorId: session.id, actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'audit_log.exported',
      entityType: 'workspace', entityId: session.workspaceId, entityName: session.workspaceName,
      metadata: {
        format, from: fromDate.toISOString(), to: upper.toISOString(),
        project_id: projectId || null, actor_id: actorParam || null, category: category || null,
        search: q || null, row_count: pageRows.length, total_count: totalCount, truncated,
      },
    })

    return new NextResponse(body as any, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    console.error('Audit export error:', err)
    return NextResponse.json({ error: 'Could not load the audit log' }, { status: 500 })
  }
}

function exportFilename(workspaceName: string, from: Date, to: Date, ext: 'csv' | 'pdf'): string {
  const slug = (workspaceName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace'
  const d = (dt: Date) => dt.toISOString().slice(0, 10)
  return `${slug}-audit-log-${d(from)}-to-${d(to)}.${ext}`
}

function toCsv(rows: any[], canViewFinancials: boolean, truncated: boolean, totalCount: number): string {
  const header = ['Timestamp (UTC)', 'Event', 'Entity type', 'Entity', 'Entity ID', 'Actor name', 'Actor email', 'IP address', 'Metadata']
  const lines: string[] = []
  // Same single-cell note-line convention as the reports CSVs.
  if (truncated) {
    lines.push(csvRow([`This export shows the first ${rows.length.toLocaleString()} of ${totalCount.toLocaleString()} matching events. Narrow the date range or filters to capture the rest.`]))
  }
  lines.push(csvRow(header))
  for (const r of rows) {
    const metadata = redactMetadata(r.metadata, canViewFinancials)
    lines.push(csvRow([
      new Date(r.created_at).toISOString(),
      r.event_type,
      r.entity_type,
      r.entity_name || '',
      r.entity_id || '',
      r.actor_name || 'System',
      r.actor_email || '',
      r.ip_address || '',
      metadata && Object.keys(metadata).length ? JSON.stringify(metadata) : '',
    ]))
  }
  return lines.join('\r\n')
}
