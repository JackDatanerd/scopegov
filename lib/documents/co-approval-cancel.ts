import { cancelApprovalRequest } from '@/lib/approvals/engine'

/**
 * FIX (CO logic, independent pass 6 — close/withdraw/exception/revise): cancel the approval requests that can be in
 * flight against a change order, and REPORT a cancel that was refused because a final-approval send is running.
 *
 * A gated CO has two request kinds that share its id: 'co' (a draft awaiting approval to be sent) and 'co_counter'
 * (a counter-offer awaiting approval to be accepted). Close, withdraw, exception and revise each call
 * cancelApprovalRequest for them, but every one ignored its `blockedBySend` result and ran AFTER the CO's status had
 * already been flipped. The approvalSendInFlight pre-check reads the request BEFORE that write, so the last approver
 * clearing the final step in the gap stamped the send claim: cancelApprovalRequest then (correctly) refused to cancel,
 * the route carried on, and the auto-send ran against a CO that was no longer a draft/countered. Result: a closed CO
 * with an "Approved — not sent" request that can never be retried, and the requester told their send failed.
 *
 * Call this BEFORE the status write, and answer 409 when `blockedBySend` is true — exactly what invoice DELETE does.
 * Cancelling first is safe if the status write then loses its own race: the request is for a CO another action is
 * already moving out of the state the request was waiting on, and those actions cancel it themselves.
 *
 * Every caller runs inside its route's try/catch, and cancelApprovalRequest throws on a failed lookup (an unreadable
 * request must never read as "nothing to cancel"), so this does not swallow errors.
 */
export async function cancelCoApprovals(
  service: any,
  params: {
    workspaceId: string
    coId: string
    actorId: string
    actorEmail: string
    actorName: string
    reason: string
    /** Which request kinds to look for. Defaults to both; a state that can only hold one may narrow it. */
    types?: Array<'co' | 'co_counter'>
  },
): Promise<{ blockedBySend: boolean }> {
  let blockedBySend = false
  for (const documentType of params.types ?? (['co', 'co_counter'] as const)) {
    const result = await cancelApprovalRequest(service, {
      documentType, documentId: params.coId, workspaceId: params.workspaceId,
      actorId: params.actorId, actorEmail: params.actorEmail, actorName: params.actorName,
      reason: params.reason,
    })
    if (result.blockedBySend) blockedBySend = true
  }
  return { blockedBySend }
}
