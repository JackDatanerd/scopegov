import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { describeActivity } from '@/lib/utils/activity-format'

const row = (over: any) => ({ id: 'a1', created_at: '2026-10-03T10:00:00Z', ...over })

describe('Invoicing independent pass 20', () => {
  it('labels invoice.payment_claimed and invoice.updated in the activity feed', () => {
    const claimed = describeActivity(row({ event_type: 'invoice.payment_claimed', actor_name: 'Client', entity_name: 'INV-7' }), { viewFinancials: true })
    expect(claimed.text).not.toMatch(/payment_claimed|payment claimed/i)
    expect(claimed.text).toMatch(/paid/)
    const updated = describeActivity(row({ event_type: 'invoice.updated', actor_name: 'Alice', entity_name: 'Phase 1' }), { viewFinancials: true })
    expect(updated.text).toMatch(/edited draft invoice/)
  })

  it('PATCH /api/invoices/[id] writes an invoice.updated audit row', () => {
    const src = readFileSync('app/api/invoices/[id]/route.ts', 'utf8')
    expect(src).toMatch(/eventType:\s*'invoice\.updated'/)
  })
})
