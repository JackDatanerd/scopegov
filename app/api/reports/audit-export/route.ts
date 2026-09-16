export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
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
const MAX_ROWS_JSON = 500 // table view shows a "truncated, use CSV export" banner beyond this — see components/settings/AuditLogClient.tsx (no true pagination exists here)

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_AUDIT_LOG')) {
      return NextResponse.json({ error: 'Missing permission: VIEW_AUDIT_LOG' }, { status: 403 })
    }
    // FIX (re-audit): VIEW_AUDIT_LOG and VIEW_FINANCIALS are independent
    // toggles on a fully custom per-workspace role (roles.permissions
    // jsonb — no fixed role table), so a role with audit access but no
    // financial visibility is a realistic combination, not a contrived
    // edge case. Used below to redact dollar figures out of the CSV's
    // Metadata column — see toCsv/redactMetadata for the full note.
    const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')

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
      const [proj, sows, cos, flags, checks, exceptions] = await Promise.all([
        (service as any).from('projects').select('id, name').eq('id', projectId).eq('workspace_id', session.workspaceId).maybeSingle(),
        (service as any).from('sow_documents').select('id').eq('project_id', projectId),
        (service as any).from('change_orders').select('id').eq('project_id', projectId),
        (service as any).from('guardian_flags').select('id').eq('project_id', projectId),
        (service as any).from('guardian_checks').select('id').eq('project_id', projectId),
        // FIX (re-audit): exceptions_log was never resolved here, so
        // flag_comment.added/flag_attachment.added events logged against an
        // exception (entityType: 'exception', entityId: exceptions_log.id —
        // see scope-governance/[entityType]/.../comments and attachments)
        // silently vanished from a project-filtered audit export, even
        // though granting/discussing an exception is squarely
        // project-scoped activity.
        (service as any).from('exceptions_log').select('id').eq('project_id', projectId),
      ])
      projectName = proj.data?.name
      projectEntityIds = [
        projectId,
        ...(sows.data || []).map((r: any) => r.id),
        ...(cos.data || []).map((r: any) => r.id),
        ...(flags.data || []).map((r: any) => r.id),
        ...(checks.data || []).map((r: any) => r.id),
        ...(exceptions.data || []).map((r: any) => r.id),
      ]
      if (!proj.data) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
    }

    let actorName: string | undefined
    if (actorId) {
      // FIX (audit round 6): this lookup had no workspace scope, unlike
      // every other query in this route — passing an arbitrary actorId
      // for a user in a different workspace would pull that person's real
      // name into this workspace's exported PDF ("Filters: actor: X"). The
      // actual audit_log rows returned were still safely workspace-scoped
      // (nothing in the log itself leaked), but this name lookup wasn't.
      // Scope it through workspace_members instead of querying `users`
      // directly.
      const { data: member } = await (service as any)
        .from('workspace_members')
        .select('users(name)')
        .eq('workspace_id', session.workspaceId)
        .eq('user_id', actorId)
        .maybeSingle()
      actorName = member?.users?.name
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
    // FIX (audit round 3): `q` used to be interpolated raw into the .or()
    // filter string — PostgREST's or() syntax is comma/paren-delimited, so
    // untrusted commas/parens/dots in `q` could break the intended filter
    // shape. workspace_id is a separate, independently-ANDed query param
    // so this was never a cross-tenant read, but it's still the wrong way
    // to build this query and the kind of pattern that becomes a real bug
    // the next time it's copied somewhere without that compensating
    // filter. Escape PostgREST's own special characters before building
    // the filter string, same idea as escaping a LIKE pattern.
    //
    // FIX (deep audit, Settings re-pass): the escape set didn't include
    // `%` or `_` — ILIKE's own wildcard characters — so typing either into
    // the search box let it match more broadly than the literal text
    // typed (e.g. "50%" matching any digits-then-anything). No cross-
    // tenant exposure (workspace_id stays independently scoped) but still
    // the wrong result for a literal search. Backslash is ILIKE's default
    // escape character, same as it already is for PostgREST's filter
    // syntax, so folding these into the same escape pass is correct.
    if (q) {
      const escaped = q.replace(/[,()."'\\%_]/g, '\\$&')
      query = query.or(`event_type.ilike.%${escaped}%,entity_name.ilike.%${escaped}%`)
    }

    // FIX (audit round 6): a previous pass (see the "deep audit, section 5"
    // history in this file) already noticed the project filter's
    // over-fetch-then-filter-in-memory approach could silently miss rows
    // past its fetch ceiling, and patched it to at least flag `truncated`
    // when that ceiling was hit. That stops the export from confidently
    // lying about completeness, but the underlying rows are still never
    // fetched — a "trustworthy audit export" that has to tell you it might
    // be incomplete is still incomplete. We already resolve the exact set
    // of entity_ids that belong to the project right above
    // (projectEntityIds) — there's no reason not to push that down as a
    // real SQL filter instead of over-fetching and hoping. This also makes
    // `count` exact instead of an in-memory approximation, so `truncated`
    // and `totalCount` are simply correct rather than best-effort.
    if (projectEntityIds) query = query.in('entity_id', projectEntityIds)

    const { data: rawRows, count } = await query.limit(maxRows + 1)

    const rows = (rawRows || []) as any[]
    const totalCount = count ?? rows.length
    const truncated = rows.length > maxRows
    const pageRows = rows.slice(0, maxRows)

    // Log the export itself — who pulled the audit trail, and with what
    // filters, is exactly the kind of thing a compliance audit trail should
    // capture about itself.
    if (format !== 'json') {
      await logAudit(service, {
        workspaceId: session.workspaceId,
        actorId: session.id, actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
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
      const csv = toCsv(pageRows, canViewFinancials)
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

// FIX (re-audit): the JSON view (format=json, above) and the PDF export
// (AuditReportRow, below) both deliberately curate their row shape and
// never surface `metadata` at all — but toCsv dumped it raw, unfiltered by
// VIEW_FINANCIALS, for every row. audit_log.metadata routinely carries real
// dollar figures (invoice amounts, CO totals, payment amounts, exception
// estimated_value, Paystack payment amounts) — this is exactly the class of
// leak /api/reports' scope mode was hardened against for
// exceptionsByProject.estimated_value. Strip the known financial keys
// rather than the whole metadata blob, so non-financial context (reasons,
// escalation notes, from/to plan tiers) is still preserved for a reader who
// genuinely can't see amounts.
// FIX (deep audit, Settings re-pass): this list was missing contract_value
// and schedule_sum — both carry real dollar figures and are logged
// verbatim: project contract-value edits (api/projects/[id]/route.ts) log
// `contractValue: { from, to }`, and SOW payment-schedule mismatches
// (portal/sow/[token]/sign/route.ts) log `schedule_sum`. Without these, a
// role with VIEW_AUDIT_LOG but not VIEW_FINANCIALS could still pull exact
// contract values straight out of a CSV export — the same leak class this
// list was built to close.
const FINANCIAL_METADATA_KEYS = ['amount', 'balance_due', 'estimated_value', 'counter_amount', 'total', 'subtotal', 'contract_value', 'contractValue', 'schedule_sum']
function redactMetadata(metadata: Record<string, unknown> | null | undefined, canViewFinancials: boolean) {
  if (!metadata || !Object.keys(metadata).length) return metadata
  if (canViewFinancials) return metadata
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    redacted[key] = FINANCIAL_METADATA_KEYS.includes(key) ? '[redacted]' : value
  }
  return redacted
}

function toCsv(rows: any[], canViewFinancials: boolean): string {
  const header = ['Timestamp (UTC)', 'Event', 'Entity type', 'Entity', 'Actor name', 'Actor email', 'IP address', 'Metadata']
  const lines = [header.map(csvCell).join(',')]
  for (const r of rows) {
    const metadata = redactMetadata(r.metadata, canViewFinancials)
    lines.push([
      new Date(r.created_at).toISOString(),
      r.event_type,
      r.entity_type,
      r.entity_name || '',
      r.actor_name || 'System',
      r.actor_email || '',
      r.ip_address || '',
      metadata && Object.keys(metadata).length ? JSON.stringify(metadata) : '',
    ].map(csvCell).join(','))
  }
  return lines.join('\r\n')
}
