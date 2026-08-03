// lib/utils/document-number.ts
//
// Phase 0 — thin client for the assign_document_number() Postgres function
// (supabase/migrations/003_document_numbering.sql). Numbers are assigned
// ONLY at send time, never on draft creation, so an abandoned draft never
// burns a number and the sequence stays continuous for anything a client
// actually saw. The atomicity lives in the SQL function itself (single
// UPSERT + RETURNING under Postgres's row lock) — this wrapper just gives
// call sites a typed, single-purpose entry point.

export type DocumentType = 'sow' | 'co' | 'invoice'

export async function assignDocumentNumber(
  service: any,
  workspaceId: string,
  documentType: DocumentType
): Promise<string> {
  const { data, error } = await service.rpc('assign_document_number', {
    p_workspace_id: workspaceId,
    p_document_type: documentType,
  })
  if (error || !data) {
    throw new Error(`Failed to assign ${documentType} document number: ${error?.message || 'unknown error'}`)
  }
  return data as string
}
