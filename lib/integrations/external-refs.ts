// lib/integrations/external-refs.ts
//
// The map between a ScopeGov thing and the object an integration made for it elsewhere (integration_external_refs, migration 170).
// It is what makes a sync idempotent: a retry or a repeat finds the record instead of creating another. Server-only.

export type RefType = 'folder' | 'file' | 'company' | 'contact' | 'deal' | 'note'
export interface RefCtx { service: any; connection: { id: string; workspace_id: string } }

export async function findRef(c: RefCtx, type: RefType, key: string): Promise<{ remote_id: string; remote_url: string | null } | null> {
  const { data, error } = await c.service.from('integration_external_refs').select('remote_id, remote_url')
    .eq('connection_id', c.connection.id).eq('ref_type', type).eq('local_key', key).maybeSingle()
  if (error) throw new Error(`ref lookup failed: ${error.message}`)
  return data || null
}

export async function saveRef(c: RefCtx, type: RefType, key: string, remoteId: string, name: string | null, url: string | null = null): Promise<void> {
  const { error } = await c.service.from('integration_external_refs').insert({
    workspace_id: c.connection.workspace_id, connection_id: c.connection.id, ref_type: type, local_key: key, remote_id: remoteId, remote_name: name, remote_url: url,
  })
  // 23505 = a concurrent delivery recorded it first: its record stands. Anything else is worth knowing about.
  if (error && (error as any).code !== '23505') console.error('[integrations] could not record external ref:', error.message)
}

export async function dropRef(c: RefCtx, type: RefType, key: string): Promise<void> {
  const { error } = await c.service.from('integration_external_refs').delete().eq('connection_id', c.connection.id).eq('ref_type', type).eq('local_key', key)
  if (error) console.error('[integrations] could not drop external ref:', error.message)
}
