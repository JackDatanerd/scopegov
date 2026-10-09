// lib/documents/signed-sow.ts
//
// "Does this project have a signed SOW?" - asked by CO create, CO send (route and sendCoDocument) and the
// client-side acceptance finalizer. supabase-js never throws: a failed read resolves to { data: null, error }, and
// every one of those call sites read that as "no signed SOW", so a transient database error told the agency (or, in
// finalize-co, the CLIENT, after the whole signing ritual) that the project had no signed SOW. A failed lookup is not
// an answer, so it is reported separately from "none found".

import { normalizeLateFeeRate } from '@/lib/documents/late-fee'

export type SignedSowLookup =
  | { ok: true; sow: { id: string; document_number: string | null; lateFeeRate?: number | null } | null }
  | { ok: false; error: string }

export const SIGNED_SOW_LOOKUP_FAILED = 'Could not check this project\u2019s signed SOW \u2014 please try again.'

/**
 * The project's signed SOW, null when there is genuinely none, or ok:false when the read failed. `newest` also orders by
 * version so the returned document number is the current one (only the acceptance finalizer prints it); the
 * existence-only callers skip the sort.
 */
export async function findSignedSow(service: any, projectId: string, opts: { newest?: boolean } = {}): Promise<SignedSowLookup> {
  let q = service
    .from('sow_documents').select('id, document_number, metadata')
    .eq('project_id', projectId).eq('status', 'signed')
  if (opts.newest) q = q.order('version', { ascending: false })
  const { data, error } = await q.limit(1).maybeSingle()
  if (error) {
    console.error('signed-SOW lookup failed:', error.message ?? error)
    return { ok: false, error: error.message ?? 'lookup failed' }
  }
  return { ok: true, sow: data ? { id: data.id, document_number: data.document_number ?? null, lateFeeRate: normalizeLateFeeRate(data.metadata?.lateFeeRate) } : null }
}
