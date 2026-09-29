// lib/approvals/send-claim.ts
//
// The "a send is running right now" clock, pure (no I/O) so it can be unit-tested and shared. A request that
// has cleared its last step (or a retry that claimed a failed send) carries sending_started_at for the few
// seconds the send takes. A claim older than the window is presumed dead — healStuckSends() moves such a
// request into the normal retryable state — so only a YOUNG claim should block cancelling or changing the
// document underneath it. Same window the cancel route and cancelApprovalRequest() have always used.

export const SEND_CLAIM_WINDOW_MS = 2 * 60 * 1000

export function isSendClaimLive(sendingStartedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!sendingStartedAt) return false
  const t = new Date(sendingStartedAt).getTime()
  // An unparseable timestamp must not read as "live forever" — treat it as no claim.
  if (!Number.isFinite(t)) return false
  return now - t < SEND_CLAIM_WINDOW_MS
}

export const SEND_IN_FLIGHT_MESSAGE =
  'This document was just approved and is being sent to the client right now — give it a moment, then refresh and try again.'
