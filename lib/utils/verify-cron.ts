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

export function verifyCronSecret(request: NextRequest): boolean {
  const auth   = request.headers.get('authorization')
  const secret = process.env.CRON_SECRET
  if (!secret) { console.error('CRON_SECRET not set'); return false }
  return auth === `Bearer ${secret}`
}
