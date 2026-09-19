// lib/utils/request-ip.ts
//
// audit_log.ip_address is a real column shown in the settings audit table,
// the CSV and the PDF export. It used to be populated only by the handful of
// call sites that passed `ipAddress: getClientIp(request)` by hand (about 20
// of 115 logAudit calls), so for most events the field was empty — and it is
// the field most likely to matter in a real security investigation.
// logAudit() now falls back to the ambient request's IP (see
// getAmbientClientIp below) whenever a caller didn't pass one, so every audit
// event written inside a request records it without touching each call site.

import type { NextRequest } from 'next/server'

interface HeaderReader { get(name: string): string | null }

export function getClientIpFromHeaders(headers: HeaderReader): string | undefined {
  // Vercel sets x-forwarded-for (overwriting any client-supplied value);
  // take the first (client) hop. NOTE: if a proxy such as Cloudflare is ever
  // put in front of Vercel, the first hop becomes the proxy's edge IP and
  // this must switch to that proxy's real-client-IP header.
  const fwd = headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim() || undefined
  const real = headers.get('x-real-ip')
  if (real) return real.trim() || undefined
  return undefined
}

export function getClientIp(request: NextRequest | Request): string | undefined {
  return getClientIpFromHeaders(request.headers)
}
