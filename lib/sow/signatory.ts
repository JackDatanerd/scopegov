// lib/sow/signatory.ts
//
// Who signs for the client, and in what capacity, is asked once per client and remembered. The position lives on each SOW's
// metadata (clientRepresentativeTitle, next to clientRepresentative), so "remembered" means: the position the agreement last
// named for THIS person. Read through one function so moving it onto the client record later changes one place.

const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

/** The most recent position named for `clientName` among SOWs listed newest first; '' when none names one for that person. */
export function pickSignatoryTitle(
  clientName: string | null | undefined,
  sowsNewestFirst: Array<{ metadata?: Record<string, unknown> | null } | null | undefined>,
): string {
  const who = norm(clientName)
  if (!who) return ''
  for (const row of sowsNewestFirst || []) {
    const m = row?.metadata
    const title = typeof m?.clientRepresentativeTitle === 'string' ? m.clientRepresentativeTitle.trim() : ''
    if (title && norm(m?.clientRepresentative) === who) return title
  }
  return ''
}
