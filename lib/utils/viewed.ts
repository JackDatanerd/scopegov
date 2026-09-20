// lib/utils/viewed.ts
//
// FEATURE (cron/portal audit round 2). The SOW, CO and invoice portals have written
// `first_viewed_at` since migration 046, but nothing anywhere ever read it: no badge, no
// stall message, no report. "Sent 6 days ago, never opened" and "sent 6 days ago, opened
// on day 1 and sat on it" call for completely different follow-ups.
//
// Caveat worth knowing: mail scanners (Outlook SafeLinks, Gmail image proxying, corporate
// gateways) can open a link before a person does, so a *view* is a hint, not proof of
// reading. "Not opened" is the reliable signal; the wording below reflects that.

export function viewedNote(firstViewedAt: string | null | undefined): string {
  if (!firstViewedAt) return 'They have not opened it yet.'
  const d = new Date(firstViewedAt)
  if (Number.isNaN(d.getTime())) return ''
  return `First opened ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}.`
}
