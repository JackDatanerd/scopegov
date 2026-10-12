// lib/documents/signer-title.ts
//
// The contract names the client's signatory and their position in its body ("Faith Christine, Director"), taken from what the
// agency entered before drafting. The signature block printed whatever the signer typed into the optional "title" box on the
// signing page — usually nothing — so the same person was "Director" in the agreement and untitled above their signature.
// One rule for both: what the signer typed wins; otherwise the position already named in the agreement, but only when the person
// signing IS the person it names (a colleague signing in their place must not inherit someone else's title).

const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

export function resolveSignerTitle(input: {
  entered?: string | null
  signerName?: string | null
  metadata?: { clientRepresentative?: unknown; clientRepresentativeTitle?: unknown } | null
}): string | null {
  const entered = typeof input.entered === 'string' ? input.entered.trim() : ''
  if (entered) return entered
  const rep = norm(input.metadata?.clientRepresentative)
  const title = typeof input.metadata?.clientRepresentativeTitle === 'string' ? input.metadata.clientRepresentativeTitle.trim() : ''
  if (title && rep && rep === norm(input.signerName)) return title
  return null
}

/**
 * The same rule for a change order. A CO is signed by the person the SOW names, but the CO's signature block only printed what was
 * typed into the optional title box, so the SOW said "Faith Christine, Director" and the change order just "Faith Christine". The
 * position named in the project's signed SOW (else its newest SOW) is used when the signer is that person. Never throws: a failed
 * lookup leaves the title as entered.
 */
export async function resolveCoSignerTitle(
  service: any, projectId: string | null | undefined, entered: string | null | undefined, signerName: string | null | undefined,
): Promise<string | null> {
  const typed = typeof entered === 'string' ? entered.trim() : ''
  if (typed) return typed
  if (!projectId || !signerName) return null
  try {
    const { data } = await service.from('sow_documents')
      .select('status, metadata, created_at').eq('project_id', projectId)
    const rows = [...(data || [])].sort((a: any, b: any) => (a?.status === 'signed' ? 0 : 1) - (b?.status === 'signed' ? 0 : 1) || String(b?.created_at ?? '').localeCompare(String(a?.created_at ?? '')))
    for (const r of rows) {
      const title = resolveSignerTitle({ entered: null, signerName, metadata: r?.metadata })
      if (title) return title
    }
  } catch { /* leave the title as entered */ }
  return null
}
