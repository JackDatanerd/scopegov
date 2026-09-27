import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, isAdminGuardFailure } from '@/lib/auth/admin'
import { escapeIlike, quotePostgrestValue } from '@/lib/audit/search'

const PAGE_SIZE = 30
const MAX_QUERY_LENGTH = 100
const SEARCH_COLUMNS = ['email', 'name'] as const

export async function GET(request: NextRequest) {
  const guard = await requireAdmin()
  if (isAdminGuardFailure(guard)) return guard
  const { service } = guard

  const { searchParams } = request.nextUrl
  const q = (searchParams.get('q') || '').trim().slice(0, MAX_QUERY_LENGTH)
  const status = searchParams.get('status') || '' // 'active' | 'deleted' | ''
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  const from = (page - 1) * PAGE_SIZE
  const to = from + PAGE_SIZE - 1

  let query = (service as any)
    .from('users')
    .select('id, email, name, is_platform_admin, created_at, deleted_at', { count: 'exact' })
    .order('created_at', { ascending: false })

  if (status === 'active') query = query.is('deleted_at', null)
  else if (status === 'deleted') query = query.not('deleted_at', 'is', null)

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

  return NextResponse.json({ users: data || [], total: count ?? 0, page, pageSize: PAGE_SIZE })
}
