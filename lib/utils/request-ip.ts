// lib/utils/request-ip.ts
//
// FIX (audit round 6): audit_log.ip_address is a real column, selected by
// api/reports/audit-export and rendered as its own line in the settings
// audit table, the CSV header, and the PDF export — but not a single
// logAudit() call site anywhere in the app ever passed ipAddress, so it
// was always null. For a compliance/audit feature, that's the field most
// likely to matter in an actual security investigation.
//
// Retrofitting every logAudit call across the whole app is a much bigger
// refactor than this audit pass covers — this helper is wired into the
// call sites within the four sections actually audited this round
// (Guardian, Clients, Reports, Billing). Other sections' logAudit calls
// still don't pass an IP; that's a known follow-up, not something this
// pass silently claims to have fixed everywhere.

import type { NextRequest } from 'next/server'

export function getClientIp(request: NextRequest | Request): string | undefined {
  const headers = request.headers
  // Vercel sets x-forwarded-for; take the first (client) hop.
  const fwd = headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  const real = headers.get('x-real-ip')
  if (real) return real.trim()
  return undefined
}
