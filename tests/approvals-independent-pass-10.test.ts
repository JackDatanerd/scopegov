// tests/approvals-independent-pass-10.test.ts
//
// Section-11 independent pass 10 (B1–B2).
//   B1 — pickWorkflow: "also gate other currencies" must not capture a document whose OWN currency has an explicit thresholded rule
//   B2 — a dead send claim (older than the claim window) is healed at the gate / lazy list instead of answering "Sent for approval"

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { pickWorkflow } from '@/lib/approvals/pick-workflow'

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
const w = (id: string, threshold: number | null, currency: string | null, other = false) =>
  ({ id, threshold_amount: threshold, threshold_currency: currency, apply_to_other_currencies: other })

describe('B1 — a currency with its own threshold is not swept up by another currency\'s opt-in', () => {
  const usdOptIn = w('a-usd-10k', 10000, 'USD', true)
  const eur5k    = w('b-eur-5k', 5000, 'EUR')

  it('EUR below its own EUR threshold stays ungated', () => {
    expect(pickWorkflow([usdOptIn, eur5k], 1000, 'EUR')).toBeNull()
  })
  it('EUR below its own threshold falls to a catch-all, not to the USD opt-in', () => {
    expect(pickWorkflow([usdOptIn, eur5k, w('z-all', null, null)], 1000, 'EUR')?.id).toBe('z-all')
  })
  it('EUR at/above its own threshold still uses the EUR rule', () => {
    expect(pickWorkflow([usdOptIn, eur5k], 6000, 'EUR')?.id).toBe('b-eur-5k')
  })
  it('a currency with NO rule of its own is still captured by the opt-in', () => {
    expect(pickWorkflow([usdOptIn, eur5k], 1, 'KES')?.id).toBe('a-usd-10k')
  })
  it('opt-in still beats the catch-all for an unruled currency', () => {
    expect(pickWorkflow([usdOptIn, w('z-all', null, null)], 50000, 'JPY')?.id).toBe('a-usd-10k')
  })
})

describe('B2 — a dead send claim is not answered with "Sent for approval"', () => {
  const engine = read('lib/approvals/engine.ts')
  const route  = read('app/api/approvals/route.ts')
  it('the gate heals a stale pending-with-claim request before deciding', () => {
    expect(engine).toMatch(/active\.status === 'pending' && active\.sending_started_at && !isSendClaimLive\(active\.sending_started_at\)/)
    expect(engine).toMatch(/healStuckSends\(service, SEND_CLAIM_WINDOW_MS \/ 60000, workspaceId(, \{ auditHealed: true \})?\)/)
  })
  it('activeRequestResult refuses (409) a pending request that still carries a claim', () => {
    expect(engine).toMatch(/if \(active\.status === 'pending' && active\.sending_started_at\)\s*\n\s*return \{[^}]*blocked: true[^}]*status: 409/)
  })
  it('the lazy heal on GET /api/approvals uses the claim window, not 10 minutes', () => {
    expect(route).toMatch(/healStuckSends\(service, SEND_CLAIM_WINDOW_MS \/ 60000, session\.workspaceId(, \{ auditHealed: true \})?\)/)
  })
})
