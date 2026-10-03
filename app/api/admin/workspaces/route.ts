import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminRead } from '@/lib/auth/admin'
// Reusing the exact double-escaping this codebase already had to build for
// the audit-log search box (Reports & Audit re-pass #3) — building a raw
// `.or(...)` string by interpolating user input directly caused a real
// PostgREST filter-injection bug here before. escapeIlike handles the ILIKE
// layer (`\ % _`), quotePostgrestValue handles the or()-quoted-string layer
// (`\ "`); both are required, in that order.
import { escapeIlike, quotePostgrestValue } from '@/lib/audit/search'

const PAGE_SIZE = 30
const MAX_QUERY_LENGTH = 100
const MIN_LOGGED_QUERY_LENGTH = 3
const SEARCH_COLUMNS = ['name', 'slug', 'agency_name'] as const

export async function GET(request: NextRequest) {
  const guard = await requireAdmin()
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const { searchParams } = request.nextUrl
  const q = (searchParams.get('q') || '').trim().slice(0, MAX_QUERY_LENGTH)
  const plan = searchParams.get('plan') || ''
  const status = searchParams.get('status') || '' // 'active' | 'suspended' (by an admin) | 'deleted' (by the owner) | ''
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  const from = (page - 1) * PAGE_SIZE
  const to = from + PAGE_SIZE - 1

  let query = (service as any)
    .from('workspaces')
    // suspended_by_admin (migration 091) added so the panel can tell an
    // admin suspension apart from the workspace's own self-service delete —
    // both share deleted_at, but only one of them is this admin surface's
    // own doing.
    .select('id, name, slug, agency_name, plan_tier, trial_ends_at, onboarding_completed_at, created_at, deleted_at, suspended_by_admin', { count: 'exact' })
      .order('created_at', { ascending: false }).order('id', { ascending: false })

  if (status === 'active') query = query.is('deleted_at', null)
  else if (status === 'suspended') query = query.not('deleted_at', 'is', null).eq('suspended_by_admin', true)
  else if (status === 'deleted') query = query.not('deleted_at', 'is', null).eq('suspended_by_admin', false)

  if (plan) query = query.eq('plan_tier', plan)
  if (q) {
    const pattern = quotePostgrestValue(`%${escapeIlike(q)}%`)
    query = query.or(SEARCH_COLUMNS.map(col => `${col}.ilike.${pattern}`).join(','))
  }

  const { data, error, count } = await query.range(from, to)
  if (error) {
    console.error('[admin] workspaces list failed:', error.message)
    return NextResponse.json({ error: 'Could not load workspaces' }, { status: 500 })
  }

  // G2: searching tenants is an access to their data — recorded (de-duplicated, ignoring 1-2 char fragments).
  if (q.length >= MIN_LOGGED_QUERY_LENGTH && page === 1) {
    await logAdminRead(service, { actor, eventType: 'workspaces.searched', targetType: 'workspace', targetLabel: q })
  }

  return NextResponse.json({ workspaces: data || [], total: count ?? 0, page, pageSize: PAGE_SIZE })
}
