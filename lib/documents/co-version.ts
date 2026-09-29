// lib/documents/co-version.ts
//
// FIX (section-10 re-pass): app/api/co/[id]/revise/route.ts read the
// current max version for the whole PROJECT and added one — same
// read-then-insert race migration 031 / lib/documents/sow-version.ts
// fixed for SOW, plus a second, distinct bug: a project can have several
// independent, concurrently-live CO lineages (an unrelated CO each start
// at version 1 via the column default), so a project-wide max is simply
// the wrong scope — it jumps a revision's version number to whatever an
// unrelated CO in the same project happens to be at, and a project-wide
// uniqueness constraint would actively break the normal case of two
// unrelated COs both legitimately sitting at version 1.
//
// See migration 037 for the root_co_id column and the
// UNIQUE(COALESCE(root_co_id, id), version) index this relies on.
// Deliberately not a transaction/advisory lock, same reasoning as
// sow-version.ts: the unique index is the source of truth, a bounded
// retry against it is simpler and correct under PostgREST.

const UNIQUE_VIOLATION = '23505'
const MAX_ATTEMPTS = 5

export interface CoVersionInsertResult {
  ok: boolean
  id?: string
  version?: number
  error?: string
}

/**
 * Inserts a new change_orders row at the next free version within the
 * given lineage, retrying if another caller claims the same version
 * first. `rootCoId` is the resolved root of the lineage — pass
 * `parentCo.root_co_id || parentCo.id`, NOT null, even though the root
 * row itself stores NULL (see migration 037's COALESCE convention).
 * `row` must NOT contain `version` or `root_co_id` — this owns both.
 */
export async function insertNextCoVersion(
  service: any,
  rootCoId: string,
  row: Record<string, unknown>
): Promise<CoVersionInsertResult> {
  let lastError = 'Could not allocate a change order version'

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: lineage } = await service
      .from('change_orders')
      .select('version')
      .or(`id.eq.${rootCoId},root_co_id.eq.${rootCoId}`)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    const nextVersion = (lineage?.version || 0) + 1

    const { data: inserted, error } = await service
      .from('change_orders')
      .insert({ ...row, root_co_id: rootCoId, version: nextVersion })
      .select('id, version')
      .single()

    if (!error && inserted) {
      // Revising a CO clones its content forward via `parent_co_id` but used to leave co_attachments behind:
      // the superseded CO is locked (attachments can only be added/removed on a draft), so every revision
      // started with zero reference files while the same Storage objects sat there referenced only by the
      // dead version. Mirrors lib/documents/sow-version.ts — attachment rows are metadata over a
      // storage_path, so this is a cheap row copy, not a file duplication. Best-effort: a failure here must
      // not fail the revision itself. (The attachment DELETE route only removes the Storage object once no
      // row references it, so removing a copy from the draft never breaks the historical version.)
      const parentId = (row as any).parent_co_id
      if (parentId) {
        try {
          const { data: prevAttachments } = await service
            .from('co_attachments')
            .select('file_name, file_size, mime_type, storage_path, uploaded_by')
            .eq('co_id', parentId)
          if (prevAttachments && prevAttachments.length > 0) {
            const { error: copyError } = await service.from('co_attachments').insert(
              prevAttachments.map((a: any) => ({ ...a, co_id: inserted.id }))
            )
            if (copyError) console.error('CO version: could not carry attachments forward (non-fatal):', copyError.message)
          }
        } catch (copyErr) {
          console.error('CO version: could not carry attachments forward (non-fatal):', copyErr)
        }
      }
      return { ok: true, id: inserted.id, version: inserted.version }
    }

    lastError = error?.message || lastError
    if (error?.code !== UNIQUE_VIOLATION) return { ok: false, error: lastError }
  }

  return { ok: false, error: lastError }
}
