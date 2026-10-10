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
