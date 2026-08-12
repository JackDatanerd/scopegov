export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { renderAuditReportPdf, type AuditReportRow } from '@/lib/pdf/audit-report'

// GET /api/reports/audit-export
//   ?format=json|csv|pdf   (default json — powers the filtered table view)
//   &from=ISO&to=ISO       (defaults to the last 90 days)
//   &projectId=uuid
//   &actorId=uuid
//   &q=free text over event_type/entity_name
//
// Gated by VIEW_AUDIT_LOG — the same permission that already gates viewing
// the audit log itself. Exporting is a stricter form of the same read, not
// a separate capability, so it doesn't need its own permission (see the
// note in supabase/migrations/003_mfa_backup_codes.sql).

const MAX_ROWS_CSV = 25000
const MAX_ROWS_PDF = 1000
const MAX_ROWS_JSON = 500 // table view is paginated by the UI, not a bulk export

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_AUDIT_LOG')) {
      return NextResponse.json({ error: 'Missing permission: VIEW_AUDIT_LOG' }, { status: 403 })
    }

    const url = new URL(request.url)
    const format = (url.searchParams.get('format') || 'json') as 'json' | 'csv' | 'pdf'
    const projectId = url.searchParams.get('projectId') || undefined
    const actorId = url.searchParams.get('actorId') || undefined
    const q = (url.searchParams.get('q') || '').trim()

    const now = new Date()
    const defaultFrom = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    const from = url.searchParams.get('from') ? new Date(url.searchParams.get('from')!) : defaultFrom
    const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : now
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return NextResponse.json({ error: 'Invalid date range' }, { status: 400 })
    }
    // Make `to` inclusive of the whole day when it arrives as a bare date (yyyy-mm-dd)
    const toInclusive = new Date(to.getTime())
    if (url.searchParams.get('to') && !url.searchParams.get('to')!.includes('T')) {
      toInclusive.setHours(23, 59, 59, 999)
    }

    const service = createServiceClient()
    const maxRows = format === 'csv' ? MAX_ROWS_CSV : format === 'pdf' ? MAX_ROWS_PDF : MAX_ROWS_JSON

    // ── Resolve which entity_ids belong to the selected project ──────────
    // audit_log has no project_id column (see migration 003 for why that's
    // deliberate) — sow/change_order/guardian_flag/guardian_check rows all
    // carry project_id already, so we resolve the relevant entity IDs here
    // instead. Rows on entity types with no project relationship (workspace,
    // workspace_member, role, user, billing) simply never match a project
    // filter, which is correct — they aren't project-scoped.
    let projectEntityIds: string[] | null = null
    let projectName: string | undefined
    if (projectId) {
      const [proj, sows, cos, flags, checks] = await Promise.all([
        (service as any).from('projects').select('id, name').eq('id', projectId).eq('workspace_id', session.workspaceId).maybeSingle(),
        (service as any).from('sow_documents').select('id').eq('project_id', projectId),
        (service as any).from('change_orders').select('id').eq('project_id', projectId),
        (service as any).from('guardian_flags').select('id').eq('project_id', projectId),
        (service as any).from('guardian_checks').select('id').eq('project_id', projectId),
      ])
      projectName = proj.data?.name
      projectEntityIds = [
        projectId,
        ...(sows.data || []).map((r: any) => r.id),
        ...(cos.data || []).map((r: any) => r.id),
        ...(flags.data || []).map((r: any) => r.id),
        ...(checks.data || []).map((r: any) => r.id),
      ]
      if (!proj.data) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
    }

    let actorName: string | undefined
    if (actorId) {
      const { data: u } = await (service as any).from('users').select('name').eq('id', actorId).maybeSingle()
      actorName = u?.name
    }

    // ── Base query — server-side filters that ARE indexed columns ────────
    let query = (service as any)
      .from('audit_log')
      .select('id, event_type, entity_type, entity_id, entity_name, actor_name, actor_email, actor_id, created_at, metadata, ip_address', { count: 'exact' })
      .eq('workspace_id', session.workspaceId)
      .gte('created_at', from.toISOString())
      .lte('created_at', toInclusive.toISOString())
      .order('created_at', { ascending: false })

    if (actorId) query = query.eq('actor_id', actorId)
    if (q) query = query.or(`event_type.ilike.%${q}%,entity_name.ilike.%${q}%`)

    // Project filtering happens in-memory below, so we need to over-fetch
    // when a project filter is active (can't push an IN-across-entity-types
    // condition down cleanly). Bounded to a sane ceiling either way.
    const fetchLimit = projectEntityIds ? Math.max(maxRows * 4, 5000) : maxRows + 1
    const { data: rawRows, count } = await query.limit(fetchLimit)

    let rows = (rawRows || []) as any[]
    if (projectEntityIds) {
      const idSet = new Set(projectEntityIds)
      rows = rows.filter(r => r.entity_id && idSet.has(r.entity_id))
    }

    const totalCount = projectEntityIds ? rows.length : (count ?? rows.length)
    const truncated = rows.length > maxRows
    const pageRows = rows.slice(0, maxRows)

    // Log the export itself — who pulled the audit trail, and with what
    // filters, is exactly the kind of thing a compliance audit trail should
    // capture about itself.
    if (format !== 'json') {
      await logAudit(service, {
        workspaceId: session.workspaceId,
        actorId: session.id, actorEmail: session.email, actorName: session.name,
        eventType: 'audit_log.exported',
        entityType: 'workspace', entityId: session.workspaceId, entityName: session.workspaceName,
        metadata: { format, from: from.toISOString(), to: toInclusive.toISOString(), project_id: projectId || null, actor_id: actorId || null, row_count: pageRows.length },
      })
    }

    if (format === 'json') {
      return NextResponse.json({
        rows: pageRows.map(r => ({
          id: r.id, eventType: r.event_type, entityType: r.entity_type, entityName: r.entity_name,
          actorName: r.actor_name, actorEmail: r.actor_email, createdAt: r.created_at, ipAddress: r.ip_address,
        })),
        totalCount, truncated,
      })
    }

    if (format === 'csv') {
      const csv = toCsv(pageRows)
      // BUG-008 convention: Uint8Array for NextResponse BodyInit
      return new NextResponse(new Uint8Array(Buffer.from(csv, 'utf-8')), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${csvFilename(session.workspaceName, from, toInclusive)}"`,
        },
      })
    }

    if (format === 'pdf') {
      const pdfRows: AuditReportRow[] = pageRows.map(r => ({
        createdAt: r.created_at, eventType: r.event_type, actorName: r.actor_name || 'System',
        actorEmail: r.actor_email, entityType: r.entity_type, entityName: r.entity_name || '', ipAddress: r.ip_address,
      }))
      const buffer = await renderAuditReportPdf({
        agencyName: session.agencyName, workspaceName: session.workspaceName,
        generatedBy: session.name, generatedAt: new Date().toISOString(),
        from: from.toISOString(), to: toInclusive.toISOString(),
        filters: { project: projectName, actor: actorName, eventType: q || undefined },
        totalCount, truncated, rows: pdfRows,
      })
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${csvFilename(session.workspaceName, from, toInclusive).replace('.csv', '.pdf')}"`,
        },
      })
    }

    return NextResponse.json({ error: 'Unsupported format' }, { status: 400 })
  } catch (err) {
    console.error('Audit export error:', err)
    return NextResponse.json({ error: 'Could not generate export' }, { status: 500 })
  }
}

function csvFilename(workspaceName: string, from: Date, to: Date): string {
  const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace'
  const d = (dt: Date) => dt.toISOString().slice(0, 10)
  return `${slug}-audit-log-${d(from)}-to-${d(to)}.csv`
}

function csvCell(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value)
  // FIX (audit round 1): entity_name, actor_name, and metadata can all
  // contain user-supplied strings (project names, CO titles, client
  // names) that end up in this export. Without neutralizing a leading
  // =, +, -, or @, a value like "=HYPERLINK(...)" or "=cmd|'/c calc'"
  // opens as a live formula the instant an admin opens the CSV in
  // Excel/Sheets — classic CSV/formula injection. Prefixing a single
  // quote forces spreadsheet apps to treat it as text; RFC 4180 quoting
  // below still applies on top of this for commas/quotes/newlines.
  if (/^[=+\-@]/.test(str)) str = `'${str}`
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function toCsv(rows: any[]): string {
  const header = ['Timestamp (UTC)', 'Event', 'Entity type', 'Entity', 'Actor name', 'Actor email', 'IP address', 'Metadata']
  const lines = [header.map(csvCell).join(',')]
  for (const r of rows) {
    lines.push([
      new Date(r.created_at).toISOString(),
      r.event_type,
      r.entity_type,
      r.entity_name || '',
      r.actor_name || 'System',
      r.actor_email || '',
      r.ip_address || '',
      r.metadata && Object.keys(r.metadata).length ? JSON.stringify(r.metadata) : '',
    ].map(csvCell).join(','))
  }
  return lines.join('\r\n')
}
