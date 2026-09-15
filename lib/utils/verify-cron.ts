// lib/utils/verify-cron.ts
//
// FIX (audit round 3, finding #6): every cron route had its own copy of
// this check, and 11 of the 12 copies did `auth === \`Bearer
// ${process.env.CRON_SECRET}\`` with no guard for CRON_SECRET being
// unset — which turns the comparison into `auth === "Bearer undefined"`,
// a literal string an attacker can just send. Only trial-warning's copy
// (BUG-036) had the `if (!secret) return false` guard. Single shared
// helper now, so this can't drift again.

import type { NextRequest } from 'next/server'
import crypto from 'crypto'

// FIX (re-audit, cron section): plain `===` on the bearer secret is a
// timing side-channel — this codebase already treats that as a real bug
// elsewhere (see the crypto.timingSafeEqual comparisons in
// app/api/guardian/inbound/route.ts and app/api/billing/webhook/route.ts,
// both fixed in an earlier audit round for exactly this reason) but the
// consolidated cron helper reintroduced the same pattern it replaced.
// timingSafeEqual requires equal-length buffers, so length is compared
// first (which leaks length, same as every other timing-safe compare in
// this codebase — length alone isn't the secret).
export function verifyCronSecret(request: NextRequest): boolean {
  const auth   = request.headers.get('authorization')
  const secret = process.env.CRON_SECRET
  if (!secret) { console.error('CRON_SECRET not set'); return false }
  if (!auth) return false

  const expected = Buffer.from(`Bearer ${secret}`)
  const actual   = Buffer.from(auth)
  if (expected.length !== actual.length) return false
  return crypto.timingSafeEqual(expected, actual)
}
