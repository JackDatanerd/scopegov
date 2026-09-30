// lib/pdf/sow-watermark.ts
//
// Pure logic (no JSX / react-pdf), same split as lib/pdf/co-watermark.ts, so it can be unit-tested standalone.
//
// FIX (SOW lifecycle independent pass): every SOW that wasn't signed was stamped "DRAFT" across its pages —
// including one already sent to the client (awaiting signature), one the client sent back for changes, and a
// withdrawn / declined / expired version downloaded from the version history. That is the exact
// misdescription the CO PDF already fixed with coWatermarkLabel: a document the client holds is not a draft,
// and a withdrawn one must not look like a live offer.

/** What a non-executed SOW's watermark says. null for a signed (executed) SOW — no watermark is drawn. */
export function sowWatermarkLabel(status: string | null | undefined): string | null {
  switch (status) {
    case 'signed': return null
    case 'awaiting_signature': case 'changes_requested': return 'UNSIGNED'
    case 'withdrawn': return 'WITHDRAWN'
    case 'declined': return 'DECLINED'
    case 'expired': return 'EXPIRED'
    default: return 'DRAFT'
  }
}
