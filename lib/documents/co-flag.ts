// lib/documents/co-flag.ts
//
// Releasing / resolving the Guardian flag a change order is linked to, AFTER the CO has already reached a terminal
// state. Close, withdraw, revise (supersede) and exception all used to read the flag (error ignored - a failed read
// looked like "no flag") and then write it (error ignored). The CO is already terminal by then and nothing can retry,
// so one transient failure stranded the flag at 'converted_to_co' pointing at a dead CO: Guardian then refused a new
// draft with "A change order has already been drafted from this flag" and nothing was logged.
//
// One guarded conditional UPDATE (no pre-read - the filters ARE the check), retried once, failing loudly. A flag
// owned by a different CO (change_order_id set to someone else) matches nothing and is left alone.

export async function releaseFlagFromCo(
  service: any,
  p: { flagId: string; coId: string; now?: string },
): Promise<{ released: boolean; failed: boolean }> {
  const now = p.now ?? new Date().toISOString()
  let lastErr: any = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await service.from('guardian_flags')
      .update({ status: 'open', change_order_id: null, updated_at: now })
      .eq('id', p.flagId).eq('status', 'converted_to_co')
      .or(`change_order_id.eq.${p.coId},change_order_id.is.null`)
      .select('id')
    if (!error) return { released: !!data && data.length > 0, failed: false }
    lastErr = error
  }
  console.error('CO flag release failed - flag may be stranded at converted_to_co:', p.flagId, p.coId, lastErr?.message)
  return { released: false, failed: true }
}

export async function resolveFlagAsException(
  service: any,
  p: { flagId: string; coId: string; resolvedBy: string; now: string },
): Promise<{ resolved: boolean; failed: boolean }> {
  let lastErr: any = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await service.from('guardian_flags')
      .update({ status: 'resolved', resolution: 'exception', resolved_by: p.resolvedBy, resolved_at: p.now, updated_at: p.now })
      .eq('id', p.flagId).in('status', ['converted_to_co', 'open'])
      .or(`change_order_id.eq.${p.coId},change_order_id.is.null`)
      .select('id')
    if (!error) return { resolved: !!data && data.length > 0, failed: false }
    lastErr = error
  }
  console.error('CO exception: linked flag resolution failed - flag left unresolved:', p.flagId, p.coId, lastErr?.message)
  return { resolved: false, failed: true }
}

/**
 * CO-2: re-claim the flag a revision inherits. revise/route.ts copies flag_id onto the new draft BEFORE it knows the flag is
 * still available, then ran an update whose "0 rows matched" outcome it treated as success. When a teammate had meanwhile
 * drafted another change order from the same flag (the earlier version's decline had released it), the revision still
 * carried the flag: two live change orders for one flag, the same extra work billable twice.
 *
 *  - claimed:     the flag was open and unlinked and now belongs to the revision.
 *  - already_ours: it was already linked to this revision (an adopted draft whose earlier attempt got that far).
 *  - unavailable: it belongs to another change order, or is resolved/closed - the revision must not carry it.
 *  - failed:      the database could not be read or written (retried once); the caller logs it and carries on as before.
 */
export type FlagClaimOutcome = 'claimed' | 'already_ours' | 'unavailable' | 'failed'

export async function claimFlagForRevision(
  service: any,
  p: { flagId: string; revisionId: string },
): Promise<FlagClaimOutcome> {
  let lastErr: any = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await service.from('guardian_flags')
      .update({ status: 'converted_to_co', change_order_id: p.revisionId, updated_at: new Date().toISOString() })
      .eq('id', p.flagId).eq('status', 'open').is('change_order_id', null)
      .select('id')
    if (error) { lastErr = error; continue }
    if (data && data.length > 0) return 'claimed'
    // Nothing matched: either the flag is not ours to claim, or it already is ours. Look, rather than assume.
    const { data: flag, error: readErr } = await service.from('guardian_flags')
      .select('id, status, change_order_id').eq('id', p.flagId).maybeSingle()
    if (readErr) { lastErr = readErr; continue }
    if (flag && flag.change_order_id === p.revisionId) return 'already_ours'
    return 'unavailable'
  }
  console.error('CO revise: could not re-claim the linked flag:', p.flagId, p.revisionId, lastErr?.message)
  return 'failed'
}
