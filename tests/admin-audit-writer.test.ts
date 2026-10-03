// tests/admin-audit-writer.test.ts
//
// logAdminAction / logAdminRead / loadAdminHistory (lib/auth/admin.ts): B12 (a failed admin audit write was invisible)
// and G1/G2 (reads are recorded once per window; per-target history excludes the noise).
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ alerts: [] as any[] }))
vi.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: async () => ({}), createServiceClient: () => ({}) }))
vi.mock('@/lib/auth/step-up', () => ({ requireStepUpForCurrentUser: async () => null }))
vi.mock('@/lib/utils/request-ip', () => ({ getClientIpFromHeaders: () => '203.0.113.9' }))
vi.mock('next/headers', () => ({ headers: () => new Map() }))
vi.mock('@/lib/billing/ops-alert', () => ({
  alertBillingOps: async (_s: any, key: string, subject: string, lines: string[]) => { h.alerts.push({ key, subject, lines }); return true },
}))

import { logAdminAction, logAdminRead, loadAdminHistory } from '@/lib/auth/admin'

const actor = { id: 'a1', email: 'admin@scopegov.app', name: 'Admin' }
const params = { actor, eventType: 'workspace.suspended', targetType: 'workspace' as const, targetId: 'w1', targetLabel: 'Agency', metadata: { reason: 'x' } }

/** Insert fails `failures` times then succeeds. Reads return `existing`. */
function service(opts: { failures?: number; existing?: any[]; readError?: boolean } = {}) {
  let left = opts.failures ?? 0
  const inserted: any[] = []
  const filters: any[][] = []
  const query: any = {
    select: () => query, eq: (...a: any[]) => { filters.push(['eq', ...a]); return query }, is: (...a: any[]) => { filters.push(['is', ...a]); return query },
    gte: () => query, not: (...a: any[]) => { filters.push(['not', ...a]); return query }, order: () => query,
    limit: async () => (opts.readError ? { data: null, error: { message: 'read failed' } } : { data: opts.existing ?? [], error: null }),
  }
  return {
    inserted, filters,
    from: () => ({
      ...query,
      insert: async (row: any) => {
        if (left > 0) { left--; return { error: { message: 'insert failed' } } }
        inserted.push(row); return { error: null }
      },
    }),
  }
}

beforeEach(() => { h.alerts.length = 0; vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('logAdminAction (B12)', () => {
  it('writes the row with the request IP', async () => {
    const s = service()
    expect(await logAdminAction(s, params)).toBe(true)
    expect(s.inserted[0]).toMatchObject({ admin_id: 'a1', event_type: 'workspace.suspended', target_id: 'w1', ip_address: '203.0.113.9' })
    expect(h.alerts).toHaveLength(0)
  })

  it('retries once and succeeds without paging anyone', async () => {
    const s = service({ failures: 1 })
    expect(await logAdminAction(s, params)).toBe(true)
    expect(s.inserted).toHaveLength(1)
    expect(h.alerts).toHaveLength(0)
  })

  it('after two failures returns false, logs the full row for replay, and pages ops', async () => {
    const s = service({ failures: 2 })
    const spy = vi.spyOn(console, 'error')
    expect(await logAdminAction(s, params)).toBe(false)
    expect(s.inserted).toHaveLength(0)
    const line = spy.mock.calls.map(c => String(c[0])).find(m => m.startsWith('[admin-audit] UNRECORDED ADMIN ACTION '))
    expect(line).toBeTruthy()
    expect(JSON.parse(line!.replace('[admin-audit] UNRECORDED ADMIN ACTION ', ''))).toMatchObject({ event_type: 'workspace.suspended', target_id: 'w1', admin_email: 'admin@scopegov.app' })
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0].subject).toMatch(/NOT recorded/)
  })

  it('treats a thrown insert like a failed one', async () => {
    const s: any = { from: () => ({ insert: async () => { throw new Error('socket hang up') } }) }
    expect(await logAdminAction(s, params)).toBe(false)
  })
})

describe('logAdminRead (G2)', () => {
  const read = { ...params, eventType: 'workspace.viewed' }
  it('records the first view', async () => {
    const s = service()
    expect(await logAdminRead(s, read)).toBe(true)
    expect(s.inserted).toHaveLength(1)
  })
  it('does not record the same view again inside the window', async () => {
    const s = service({ existing: [{ id: 'prev' }] })
    expect(await logAdminRead(s, read)).toBe(true)
    expect(s.inserted).toHaveLength(0)
  })
  it('records anyway when the de-dupe lookup itself fails', async () => {
    const s = service({ readError: true })
    await logAdminRead(s, read)
    expect(s.inserted).toHaveLength(1)
  })
  it('scopes a search de-dupe to the search text and to "no target"', async () => {
    const s = service()
    await logAdminRead(s, { actor, eventType: 'users.searched', targetType: 'user', targetLabel: 'bob@x.com' })
    expect(s.filters).toContainEqual(['is', 'target_id', null])
    expect(s.filters).toContainEqual(['eq', 'target_label', 'bob@x.com'])
  })
})

describe('loadAdminHistory (G1)', () => {
  it('excludes views, and returns null (not []) when the read fails', async () => {
    const s = service()
    const q: any = { select: () => q, eq: () => q, not: (...a: any[]) => { s.filters.push(['not', ...a]); return q }, order: () => q, limit: async () => ({ data: [{ id: '1' }], error: null }) }
    const ok = await loadAdminHistory({ from: () => q }, 'user', 'u1')
    expect(ok).toEqual([{ id: '1' }])
    expect(s.filters).toContainEqual(['not', 'event_type', 'like', '%.viewed'])

    const bad: any = { select: () => bad, eq: () => bad, not: () => bad, order: () => bad, limit: async () => ({ data: null, error: { message: 'x' } }) }
    expect(await loadAdminHistory({ from: () => bad }, 'user', 'u1')).toBeNull()
  })
})
