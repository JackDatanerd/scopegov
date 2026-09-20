// lib/documents/executed-pdf.ts
//
// An executed (signed / accepted) SOW or change order has to be the SAME document
// forever. Until now the PDF was re-rendered from live rows on every download, so
// it drifted after signing: the agency redrawing its signature, a client or agency
// address edit, retainer renewals rewriting projects.contract_value, and monthly
// retainer milestones all changed what a "signed" PDF said. And nothing recorded
// what was signed, so a dispute could not show the content was unchanged.
//
// At the moment of signing we now (1) hash the exact agreed content and (2) render
// the PDF once and store it in the private `pdfs` bucket. Downloads serve the stored
// copy; documents signed before this shipped have no stored copy and fall back to
// the live render, exactly as before.

import { createHash } from 'node:crypto'

export const EXECUTED_PDF_BUCKET = 'pdfs'

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort().reduce((acc, k) => {
      acc[k] = stable((value as Record<string, unknown>)[k])
      return acc
    }, {} as Record<string, unknown>)
  }
  return value
}

/** SHA-256 (hex) over a canonical, key-sorted JSON encoding of `content`. */
export function computeContentHash(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(content))).digest('hex')
}

export function executedPdfPath(workspaceId: string, kind: 'sow' | 'co', id: string): string {
  return `${workspaceId}/${kind}/${id}.pdf`
}

/** Stores the executed PDF; returns the storage path, or null if storage failed (non-fatal). */
export async function storeExecutedPdf(
  service: any, params: { workspaceId: string; kind: 'sow' | 'co'; id: string; buffer: Buffer }
): Promise<string | null> {
  const path = executedPdfPath(params.workspaceId, params.kind, params.id)
  try {
    const { error } = await service.storage.from(EXECUTED_PDF_BUCKET).upload(path, params.buffer, {
      contentType: 'application/pdf', upsert: true,
    })
    if (error) {
      console.error(`[executed-pdf] upload failed for ${params.kind} ${params.id}:`, error.message ?? error)
      return null
    }
    return path
  } catch (e) {
    console.error(`[executed-pdf] upload threw for ${params.kind} ${params.id}:`, e)
    return null
  }
}

/** Reads a stored executed PDF; null when absent or unreadable (caller falls back to a live render). */
export async function fetchExecutedPdf(service: any, path: string | null | undefined): Promise<Buffer | null> {
  if (!path) return null
  try {
    const { data, error } = await service.storage.from(EXECUTED_PDF_BUCKET).download(path)
    if (error || !data) return null
    return Buffer.from(await data.arrayBuffer())
  } catch (e) {
    console.error('[executed-pdf] download failed:', e)
    return null
  }
}
