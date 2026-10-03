import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure, logAdminRead } from '@/lib/auth/admin'
import { escapeIlike, quotePostgrestValue } from '@/lib/audit/search'
import { isAnonymizedEmail } from '@/lib/utils/account-erasure'

const PAGE_SIZE = 30
const MAX_QUERY_LENGTH = 100
const MIN_LOGGED_QUERY_LENGTH = 3
const SEARCH_COLUMNS = ['email', 'name'] as const

export async function GET(request: NextRequest) {
  const guard = await requireAdmin()
  if (isAdminGuardFailure(guard)) return guard
  const { actor, service } = guard

  const { searchParams } = request.nextUrl
  const q = (searchParams.get('q') || '').trim().slice(0, MAX_QUERY_LENGTH)
  // 'active' | 'suspended' (by an admin) | 'deleted' (the user's own deletion, or erased) | '' (all)
  const status = searchParams.get('status') || ''
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  const from = (page - 1) * PAGE_SIZE
  const to = from + PAGE_SIZE - 1

  let query = (service as any)
    .from('users')
    .select('id, email, name, is_platform_admin, created_at, deleted_at, suspended_by_admin', { count: 'exact' })
    .order('created_at', { ascending: false }).order('id', { ascending: false })

  if (status === 'active') query = query.is('deleted_at', null)
  else if (status === 'suspended') query = query.not('deleted_at', 'is', null).eq('suspended_by_admin', true)
  else if (status === 'deleted') query = query.not('deleted_at', 'is', null).eq('suspended_by_admin', false)

  if (q) {
    // Same safe pattern as /api/admin/workspaces — see that file's comment.
    const pattern = quotePostgrestValue(`%${escapeIlike(q)}%`)
    query = query.or(SEARCH_COLUMNS.map(col => `${col}.ilike.${pattern}`).join(','))
  }

  const { data, error, count } = await query.range(from, to)
  if (error) {
    console.error('[admin] users list failed:', error.message)
    return NextResponse.json({ error: 'Could not load users' }, { status: 500 })
  }

  // G2: a search for a person is an access to their data — recorded (de-duplicated, ignoring 1-2 char fragments).
  if (q.length >= MIN_LOGGED_QUERY_LENGTH && page === 1) {
    await logAdminRead(service, { actor, eventType: 'users.searched', targetType: 'user', targetLabel: q })
  }

  const users = (data || []).map((u: any) => ({ ...u, erased: isAnonymizedEmail(u.email) }))
  return NextResponse.json({ users, total: count ?? 0, page, pageSize: PAGE_SIZE })
}
