// Storage cleanup for hard-purged projects / workspaces.
//
// Projects & Dashboard deep audit (trace): purge_project() / purge_workspace()
// delete the sow_attachments / co_attachments / flag_attachments ROWS, but the
// files those rows point at (bucket `flag-evidence`) were never removed, so
// every purge permanently orphaned evidence files in Storage — files that
// belong to a client engagement the workspace deleted.
//
// Executed (signed / accepted) SOW and change-order PDFs are ALSO Storage
// objects tied to a project: since migration 061 lib/documents/executed-pdf.ts
// uploads each one to the private `pdfs` bucket at `{workspaceId}/{sow|co}/{id}.pdf`
// and records the path in sow_documents.pdf_path / change_orders.pdf_path. Those
// are signed contracts carrying client names and signature images, so a purge
// that leaves them behind keeps exactly the data the purge exists to destroy.
// (This header used to call `pdf_path` a red herring — true before 061, false
// since; collectExecutedPdfPaths() below is the fix.)
//
// Safe ordering, used by both crons:
//   1. collectAttachmentPaths()  BEFORE the purge (the rows are the only record
//      of the paths). If this fails, the purge is skipped — never delete the
//      rows while we don't know which files they referenced.
//   2. the purge RPC
//   3. removeStoragePaths()      AFTER a successful purge, best-effort: a
//      removal failure is logged with the count, never fails the purge.

import { fetchPaged } from '@/lib/utils/paginate'
import { EXECUTED_PDF_BUCKET, executedPdfPath } from '@/lib/documents/executed-pdf'

export const EVIDENCE_BUCKET = 'flag-evidence'
const REMOVE_CHUNK = 100
const MAX_ROWS = 100000

export type PurgeScope = { projectId: string } | { workspaceId: string }

export async function collectAttachmentPaths(service: any, scope: PurgeScope): Promise<string[]> {
  const byProject = 'projectId' in scope
  const id = byProject ? scope.projectId : scope.workspaceId
  const col = byProject ? 'project_id' : 'workspace_id'
  const paths = new Set<string>()

  const runs: Array<Promise<{ rows: any[] }>> = [
    // sow_attachments / co_attachments have no project/workspace column of
    // their own — scope them through their parent document.
    fetchPaged<any>((from, to) => service.from('sow_attachments')
      .select('id, storage_path, sow_documents!inner(id)', { count: 'exact' })
      .eq(`sow_documents.${col}`, id)
      .order('id', { ascending: true }).range(from, to), { maxRows: MAX_ROWS }),
    fetchPaged<any>((from, to) => service.from('co_attachments')
      .select('id, storage_path, change_orders!inner(id)', { count: 'exact' })
      .eq(`change_orders.${col}`, id)
      .order('id', { ascending: true }).range(from, to), { maxRows: MAX_ROWS }),
    fetchPaged<any>((from, to) => service.from('flag_attachments')
      .select('id, storage_path', { count: 'exact' })
      .eq(col, id)
      .order('id', { ascending: true }).range(from, to), { maxRows: MAX_ROWS }),
  ]
  for (const res of await Promise.all(runs)) {
    for (const r of res.rows) if (r.storage_path) paths.add(r.storage_path)
  }
  return Array.from(paths)
}

/**
 * Paths of the stored executed-document PDFs (`pdfs` bucket) for every SOW / change order in scope.
 * Uses the recorded pdf_path when present; for a signed/accepted document with no recorded path (the
 * upload succeeded but the follow-up UPDATE failed) it falls back to the deterministic path the
 * uploader always uses, so that orphan is collected too. Removing a path that never existed is a
 * harmless no-op in Storage.
 */
export async function collectExecutedPdfPaths(service: any, scope: PurgeScope): Promise<string[]> {
  const byProject = 'projectId' in scope
  const id = byProject ? scope.projectId : scope.workspaceId
  const col = byProject ? 'project_id' : 'workspace_id'
  const paths = new Set<string>()

  const [sows, cos] = await Promise.all([
    fetchPaged<any>((from, to) => service.from('sow_documents')
      .select('id, workspace_id, status, pdf_path', { count: 'exact' })
      .eq(col, id)
      .order('id', { ascending: true }).range(from, to), { maxRows: MAX_ROWS }),
    fetchPaged<any>((from, to) => service.from('change_orders')
      .select('id, workspace_id, status, pdf_path', { count: 'exact' })
      .eq(col, id)
      .order('id', { ascending: true }).range(from, to), { maxRows: MAX_ROWS }),
  ])
  for (const r of sows.rows) {
    if (r.pdf_path) paths.add(r.pdf_path)
    else if (r.status === 'signed' && r.workspace_id) paths.add(executedPdfPath(r.workspace_id, 'sow', r.id))
  }
  for (const r of cos.rows) {
    if (r.pdf_path) paths.add(r.pdf_path)
    else if (r.status === 'accepted' && r.workspace_id) paths.add(executedPdfPath(r.workspace_id, 'co', r.id))
  }
  return Array.from(paths)
}

/** Removes evidence + executed-PDF files for a purged scope (best-effort, never throws). */
export async function removePurgedFiles(
  service: any, evidencePaths: string[], pdfPaths: string[],
): Promise<{ removed: number; failed: number }> {
  const a = await removeStoragePaths(service, evidencePaths, EVIDENCE_BUCKET)
  const b = await removeStoragePaths(service, pdfPaths, EXECUTED_PDF_BUCKET)
  return { removed: a.removed + b.removed, failed: a.failed + b.failed }
}

export async function removeStoragePaths(
  service: any, paths: string[], bucket: string = EVIDENCE_BUCKET,
): Promise<{ removed: number; failed: number }> {
  let removed = 0
  let failed = 0
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const chunk = paths.slice(i, i + REMOVE_CHUNK)
    try {
      const { error } = await service.storage.from(bucket).remove(chunk)
      if (error) { failed += chunk.length; console.error(`Storage cleanup: failed to remove ${chunk.length} object(s) from "${bucket}":`, error) }
      else removed += chunk.length
    } catch (e) {
      failed += chunk.length
      console.error(`Storage cleanup: exception removing ${chunk.length} object(s) from "${bucket}":`, e)
    }
  }
  return { removed, failed }
}
