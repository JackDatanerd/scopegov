// lib/utils/workspace-secret.ts
//
// jwt_secret used to live directly on public.workspaces, readable by any
// active workspace member through Supabase's own PostgREST API (RLS is
// row-level, not column-level — see migration 013 for the full writeup).
// It now lives in public.workspace_secrets, a table with RLS enabled and
// zero policies, reachable only through the service-role client. This is
// the single place that reads it, so every portal/send route goes through
// the same primitive rather than re-deriving the query.
//
// Callers MUST already be using a service-role client (createServiceClient()) —
// this function does nothing to enforce that itself, since RLS on
// workspace_secrets makes an anon/authenticated client simply get nothing
// back rather than an error.

export async function getWorkspaceJwtSecret(service: any, workspaceId: string): Promise<string | null> {
  const { data } = await service
    .from('workspace_secrets')
    .select('jwt_secret')
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return data?.jwt_secret || null
}

// FIX (deep audit, Workspace lifecycle + Onboarding re-pass — flagship
// finding, traced beyond both sections): workspace/delete/route.ts soft-
// deletes a workspace (deactivates every member, cancels billing) but
// every portal API route (SOW sign/route/request-changes/decline/pdf, CO
// accept/counter/countersign/decline/route/pdf, invoice route/dispute/pdf)
// had zero references to workspace.deleted_at anywhere — grep-confirmed
// across the whole portal surface. A client's SOW-signing or CO-accept
// link kept working indefinitely after the agency "deleted" the
// workspace, letting them create a real signed SOW or accepted CO — with
// milestones, PDFs, audit-log rows, and emails — against a workspace the
// rest of the app treats as gone. This is the one check every portal
// route now runs (same choke point as getWorkspaceJwtSecret above, which
// every one of those routes already imports), right after the document's
// workspace_id is known and before anything else happens.
//
// FIX (portal audit, section 18 re-pass): the claim above — "every portal
// route now runs this" — was false for exactly the three /pdf routes it
// names (SOW/CO/invoice). All three read-only document downloads had zero
// references to this function despite being explicitly listed here as
// covered; grep-confirmed at the time this note was added. Lower severity
// than the mutating paths above (no new signed/accepted document gets
// created), but still live disclosure of a signed SOW, an accepted CO, or
// an invoice for a workspace the rest of the app treats as gone. All three
// now call this before generating the PDF, closing the gap this comment
// already claimed was closed.
export async function isWorkspaceDeleted(service: any, workspaceId: string): Promise<boolean> {
  const { data } = await service
    .from('workspaces')
    .select('deleted_at')
    .eq('id', workspaceId)
    .maybeSingle()
  // Fail closed: if the workspace row can't be found or read at all,
  // treat it the same as deleted rather than letting a lookup failure
  // silently permit the action through.
  return !data || !!data.deleted_at
}
