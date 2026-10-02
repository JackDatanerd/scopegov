// lib/pdf/co-watermark.ts
//
// Split out of renderer.tsx: pure logic (no JSX/react-pdf) so it can be unit-tested without pulling in the whole
// PDF-rendering module, which vite's import analyzer can't parse standalone outside the app bundle.

/** What a non-executed CO's watermark says. null for an accepted (executed) CO — no watermark is drawn. */
export function coWatermarkLabel(status: string | null | undefined): string | null {
  switch (status) {
    case 'accepted': return null
    case 'awaiting_response': case 'awaiting_countersignature': case 'countered': case 'stalled': return 'UNSIGNED'
    case 'withdrawn': return 'WITHDRAWN'
    case 'declined': return 'DECLINED'
    case 'closed': return 'CLOSED'
    case 'expired': return 'EXPIRED'
    case 'exception_granted': return 'EXCEPTION'
    default: return 'DRAFT'
  }
}

/**
 * The status badge printed in a CO PDF's header. 'awaiting_response' used to read "Pending Approval", but that status
 * means the CO has been SENT and is waiting on the CLIENT — a change order waiting on an internal approval is still a
 * draft — and the watermark on the same page says UNSIGNED. (Split out here so it can be unit-tested.)
 */
export const CO_STATUS_LABEL: Record<string, string> = {
  draft:                     'Draft',
  awaiting_response:         'Awaiting Response',
  awaiting_countersignature: 'Awaiting Countersignature',
  accepted:                  'Accepted',
  declined:                  'Declined',
  countered:                 'Countered',
  closed:                    'Closed',
  stalled:                   'Stalled',
  withdrawn:                 'Withdrawn',
  exception_granted:         'Exception Granted',
  expired:                   'Expired',
}
