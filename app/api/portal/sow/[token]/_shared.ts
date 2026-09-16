// app/api/portal/sow/[token]/_shared.ts
//
// FIX (re-audit, portal section): this file used to export a full
// getSowByToken() that fetched a fixed set of SOW columns AND did the
// revoked/JWT checks — but nothing ever imported it. All four routes
// (route.ts, sign, decline, request-changes) hand-rolled their own inline
// copy of the revoked-token-check + jwtVerify logic instead, each fetching
// a different, route-specific set of SOW columns. A "consolidated" helper
// that nobody actually calls provides zero protection against the exact
// thing it was meant to prevent — see the decline-route fix (this same
// re-audit) for a case where that drift already produced a real bug.
//
// Redesigned narrower: the SOW row shape genuinely differs per route (each
// needs different joins), so this only extracts the part that's true
// boilerplate everywhere — revoked-token lookup and JWT verification —
// and returns a plain result instead of writing a NextResponse directly,
// since the GET route needs soft `{state: ...}` 200 responses while the
// mutation routes need real 4xx/5xx status codes. Callers translate the
// result into whatever response shape they need.

import { jwtVerify } from 'jose'
import { getWorkspaceJwtSecret } from '@/lib/utils/workspace-secret'

export async function checkRevokedToken(
  service: any, token: string
): Promise<{ revoked: boolean; reason?: string; documentId?: string }> {
  const { data: revoked } = await service
    .from('revoked_tokens')
    .select('reason, document_id')
    .eq('token', token)
    .single()
  return revoked
    ? { revoked: true, reason: revoked.reason, documentId: revoked.document_id || undefined }
    : { revoked: false }
}

export async function verifySowJwt(service: any, token: string, workspaceId: string): Promise<boolean> {
  try {
    const jwtSecret = await getWorkspaceJwtSecret(service, workspaceId)
    if (!jwtSecret) throw new Error('no secret')
    const secret = new TextEncoder().encode(jwtSecret)
    await jwtVerify(token, secret)
    return true
  } catch {
    return false
  }
}
