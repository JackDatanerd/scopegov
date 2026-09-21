// lib/utils/invoice-registry.ts
//
// FEATURE (section-12 audit, pass 2): the invoice registry was a static table —
// no filter, no search, no paging (a hard 500-row cap), no export, "Outstanding" as a
// COUNT rather than money, and no view of how overdue the money is. Shared by
// app/(app)/invoices/page.tsx and app/api/invoices/export so the CSV a user
// downloads is exactly the list they were looking at.

export const REGISTRY_STATUS_FILTERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All' },
  { id: 'outstanding', label: 'Outstanding' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'disputed', label: 'Disputed' },
  { id: 'paid', label: 'Paid' },
  { id: 'draft', label: 'Drafts' },
  { id: 'void', label: 'Void' },
]
const VALID = new Set(REGISTRY_STATUS_FILTERS.map(f => f.id).concat(['sent', 'partially_paid']))

export interface RegistryFilters { status: string; q: string }

export function parseRegistryFilters(params: { status?: string | string[]; q?: string | string[] }): RegistryFilters {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || ''
  const status = one(params.status)
  // PostgREST's or()/ilike syntax reserves , ( ) * % \ — none of them mean anything in a
  // human search term, and left in they'd let a term rewrite the filter.
  const q = one(params.q).replace(/[,()*%\\"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
  return { status: VALID.has(status) ? status : '', q }
}

/** Projects whose own name, or whose client's name/company, matches the search text. */
export async function projectIdsMatching(service: any, workspaceId: string, q: string): Promise<string[]> {
  if (!q) return []
  const like = `%${q}%`
  const [{ data: byName }, { data: clients }] = await Promise.all([
    service.from('projects').select('id').eq('workspace_id', workspaceId).ilike('name', like).limit(200),
    service.from('clients').select('id').eq('workspace_id', workspaceId).or(`name.ilike.${like},company_name.ilike.${like}`).limit(200),
  ])
  const ids = new Set<string>((byName || []).map((p: any) => p.id))
  const clientIds = (clients || []).map((c: any) => c.id)
  if (clientIds.length > 0) {
    const { data: byClient } = await service.from('projects').select('id').eq('workspace_id', workspaceId).in('client_id', clientIds).limit(500)
    for (const p of byClient || []) ids.add(p.id)
  }
  return Array.from(ids)
}

/** Applies the status filter and text search to an `invoices` query. */
export function applyRegistryFilters(query: any, filters: RegistryFilters, textProjectIds: string[]): any {
  switch (filters.status) {
    case 'outstanding': query = query.in('status', ['sent', 'partially_paid', 'overdue']); break
    case 'disputed':    query = query.not('disputed_at', 'is', null).is('dispute_resolved_at', null); break
    case '':            break
    default:            query = query.eq('status', filters.status)
  }
  if (filters.q) {
    const parts = [`invoice_number.ilike.%${filters.q}%`, `title.ilike.%${filters.q}%`]
    if (textProjectIds.length > 0) parts.push(`project_id.in.(${textProjectIds.join(',')})`)
    query = query.or(parts.join(','))
  }
  return query
}

export const AGING_BUCKETS = ['Not yet due', '1–30 days', '31–60 days', '61–90 days', '90+ days'] as const

/** Which aging bucket an unpaid invoice falls in, by whole days past its due date (no due date = not yet due). */
export function agingBucket(dueDate: string | null | undefined, today: Date = new Date()): number {
  if (!dueDate) return 0
  const due = Date.parse(dueDate.slice(0, 10) + 'T00:00:00Z')
  if (!Number.isFinite(due)) return 0
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const days = Math.floor((t - due) / 86400000)
  if (days <= 0) return 0
  if (days <= 30) return 1
  if (days <= 60) return 2
  if (days <= 90) return 3
  return 4
}
