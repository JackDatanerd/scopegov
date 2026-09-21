// lib/utils/workspace-time.ts
import { resolveTimeZone } from '@/lib/utils/timezone'

/** The workspace's configured timezone (UTC when unset or unusable). */
export async function getWorkspaceTimeZone(service: any, workspaceId: string): Promise<string> {
  const { data } = await service.from('workspaces').select('timezone').eq('id', workspaceId).maybeSingle()
  return resolveTimeZone(data?.timezone)
}
