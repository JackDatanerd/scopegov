// lib/documents/sow-pdf-name.ts
//
// One filename for a SOW's PDF (SOW lifecycle pass 17, B5). The routes built it with
// name.replace(/[^a-z0-9]/gi, '-'), so a project named in another script became "SOW-------v1.pdf" and a missing
// project join printed "SOW-undefined-v1.pdf". Accents are folded, the slug is trimmed and capped, and an empty
// slug falls back to the document number (or plain "SOW").
export function sowPdfFilename(
  projectName: string | null | undefined, version: number | string | null | undefined,
  documentNumber?: string | null, suffix = '',
): string {
  const slug = String(projectName || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  const num = String(documentNumber || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const head = slug ? `SOW-${slug}` : (num || 'SOW')
  const v = version !== null && version !== undefined && version !== '' ? `-v${version}` : ''
  return `${head}${v}${suffix}.pdf`
}
