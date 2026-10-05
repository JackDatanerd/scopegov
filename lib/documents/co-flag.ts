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
