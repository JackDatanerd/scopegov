// lib/documents/sow-version.ts
//
// FIX (section-9 audit, 9-B12): three separate places create a new
// sow_documents row by reading the current max version and adding one —
// app/api/sow/generate/route.ts, app/api/portal/sow/[token]/request-changes/route.ts,
// and (new) app/api/sow/[id]/reopen/route.ts. All three had the same
// read-then-insert race. Migration 031 adds the missing
// UNIQUE(project_id, version) index; this helper is the other half of
// that fix — it turns the constraint from "your insert 500s" into
// "recompute and retry", so the race resolves itself instead of
// surfacing as a failed generation.
//
// Deliberately NOT a transaction or advisory lock: the unique index is
// the real source of truth, and a bounded retry against it is both
// simpler and correct under PostgREST, which has no multi-statement
// transaction primitive available to us here.

const UNIQUE_VIOLATION = '23505'
const MAX_ATTEMPTS = 5

export interface SowVersionInsertResult {
  ok: boolean
  id?: string
  version?: number
  error?: string
}

/**
 * Inserts a new sow_documents row at the next free version for the
 * project, retrying if another caller claims the same version first.
 * `row` must NOT contain `version` — this owns that field.
 */
export async function insertNextSowVersion(
  service: any,
  projectId: string,
  row: Record<string, unknown>
): Promise<SowVersionInsertResult> {
  let lastError = 'Could not allocate a SOW version'

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: latest } = await service
      .from('sow_documents')
      .select('version')
      .eq('project_id', projectId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    const nextVersion = (latest?.version || 0) + 1

    const { data: inserted, error } = await service
      .from('sow_documents')
      .insert({ ...row, project_id: projectId, version: nextVersion })
      .select('id, version')
      .single()

    if (!error && inserted) {
      // FIX (SOW lifecycle independent pass, S3): reopen and portal request-changes both clone
      // sections/metadata forward via `previous_version_id` but never touched sow_attachments — the
      // old version is locked once superseded, so every new draft started with zero reference files,
      // even though the same storage objects were still sitting there unreferenced by the new row.
      // Attachment rows are metadata over a storage_path, not the file bytes, so this is a cheap copy,
      // not a file duplication. Best-effort: a failure here must not fail the version creation itself.
      const prevId = (row as any).previous_version_id
      if (prevId) {
        try {
          const { data: prevAttachments } = await service
            .from('sow_attachments')
            .select('file_name, file_size, mime_type, storage_path, uploaded_by')
            .eq('sow_id', prevId)
          if (prevAttachments && prevAttachments.length > 0) {
            await service.from('sow_attachments').insert(
              prevAttachments.map((a: any) => ({ ...a, sow_id: inserted.id }))
            )
          }
        } catch (copyErr) {
          console.error('SOW version: could not carry attachments forward (non-fatal):', copyErr)
        }
      }
      return { ok: true, id: inserted.id, version: inserted.version }
    }

    lastError = error?.message || lastError
    // Anything other than a version collision is a real failure — don't
    // burn retries on it.
    if (error?.code !== UNIQUE_VIOLATION) return { ok: false, error: lastError }
  }

  return { ok: false, error: lastError }
}
