// tests/billing-pass11-audit-ip.test.ts
//
// Billing independent pass 11 — B2 at the source: lib/utils/audit.ts logAudit() fills ip_address from the ambient
// request unless told not to. `omitClientIp` (used by the Paystack webhook) suppresses that; an explicit
// ipAddress still wins, and ordinary callers are unchanged.

import { describe, it, expect, vi } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

vi.mock('next/headers', () => ({
  headers: () => ({ get: (n: string) => (n.toLowerCase() === 'x-forwarded-for' ? '203.0.113.9, 10.0.0.1' : null) }),
}))

import { logAudit } from '@/lib/utils/audit'

const base = { workspaceId: 'w1', actorId: null, actorEmail: 'a@b.test', actorName: 'A', eventType: 'billing.payment_succeeded', entityType: 'workspace', entityId: 'w1' }
const ipOf = async (extra: Record<string, unknown>) => {
  const db = createFakeSupabase({})
  expect(await logAudit(db.client, { ...base, ...extra } as any)).toBe(true)
  return db.tables.audit_log[0].ip_address
}

describe('logAudit ip_address', () => {
  it('an ordinary caller still gets the ambient request IP', async () => {
    expect(await ipOf({})).toBe('203.0.113.9')
  })
  it('omitClientIp records no IP instead of the provider\'s', async () => {
    expect(await ipOf({ omitClientIp: true })).toBeNull()
  })
  it('an explicit ipAddress wins over omitClientIp', async () => {
    expect(await ipOf({ omitClientIp: true, ipAddress: '198.51.100.7' })).toBe('198.51.100.7')
  })
  it('system actors are unchanged (no IP)', async () => {
    expect(await ipOf({ actorEmail: 'cron@scopegov.app' })).toBeNull()
  })
})
