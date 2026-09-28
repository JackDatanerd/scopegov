// lib/documents/co-pdf-name.ts
//
// One filename for a change order's PDF, wherever it is served or attached. The download route used the title
// (every non-ASCII character became a dash, so a title in another script produced "CO-------.pdf"), the accepted-CO
// email attachment used the PROJECT name, and the portal used the bare document number — three names for one
// document. Document number first (it is what the client's paperwork refers to), then a readable ASCII slug.

export function coPdfFilename(documentNumber: string | null | undefined, title: string | null | undefined, suffix = ''): string {
  const slug = String(title || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const num = String(documentNumber || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const base = [num || 'CO', slug].filter(Boolean).join('-')
  return `${base}${suffix}.pdf`
}
