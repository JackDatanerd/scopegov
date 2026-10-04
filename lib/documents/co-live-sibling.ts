/**
 * One live version per change-order lineage. Two live siblings (e.g. two revisions of the same declined CO) could both
 * be accepted — billing the same extra work twice — so a CO can only be sent while no other version of its lineage is
 * still open or accepted.
 *
 * FIX (CO logic, independent pass 6): this check lived only inside sendCoDocument, which runs AFTER the approval gate.
 * A CO that needed approval therefore created an approval request (edit-locking the draft and queueing it for the
 * approvers) for a send that could never succeed: the approver's decision fired the auto-send, sendCoDocument refused,
 * and the requester got an "Approved — not sent" they could do nothing with until the sibling was closed. It is shared
 * here so the send route can run it up front, like every other preflight (see lib/documents/preflight.ts), while
 * sendCoDocument keeps running it for the auto-send path — the two can no longer drift.
 */
export const LIVE_CO_STATUSES = ['awaiting_response', 'stalled', 'countered', 'awaiting_countersignature', 'accepted']

/** The user-facing refusal when another version of this CO's lineage is still live, or null when sending is fine. */
export async function liveCoSiblingMessage(
  service: any,
  co: { id: string; root_co_id?: string | null },
): Promise<string | null> {
  const rootId = co.root_co_id || co.id
  const { data: liveSiblings, error } = await service
    .from('change_orders').select('id, version, status')
    .or(`id.eq.${rootId},root_co_id.eq.${rootId}`).neq('id', co.id)
    .in('status', LIVE_CO_STATUSES).limit(1)
  // A failed lookup must NOT read as "no live sibling": that let a second version go out beside a live one, and two live
  // versions can both be accepted (the same extra work billed twice). Refuse and say why; the caller can simply retry.
  if (error) {
    console.error('CO live-sibling check failed (blocking the send):', error.message)
    return 'Could not check whether another version of this change order is still open — please try again.'
  }
  if (liveSiblings && liveSiblings.length > 0)
    return `Version ${liveSiblings[0].version} of this change order is still open (${String(liveSiblings[0].status).replace(/_/g, ' ')}). Withdraw or close it before sending another version.`
  return null
}
