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
