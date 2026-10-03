// lib/utils/workspace-currency.ts
//
// The workspace's configured currency, for the one case where nothing else can pick a currency: a workspace with
// no projects at all. Every other surface derives the money currency from the data; an empty workspace used to be
// shown (and snapshotted) as USD whatever its Settings said, which then mismatched every snapshot once the first
// real project landed in the workspace's own currency.
//
// Never throws: this is a display/labelling fallback, so a failed or malformed read degrades to null and the caller
// keeps its historical 'USD' default instead of failing the whole report or the nightly rollup.
export async function getWorkspaceCurrency(service: any, workspaceId: string): Promise<string | null> {
  try {
    const { data } = await service.from('workspaces').select('currency').eq('id', workspaceId).maybeSingle()
    const c = typeof data?.currency === 'string' ? data.currency.trim().toUpperCase() : ''
    return /^[A-Z]{3}$/.test(c) ? c : null
  } catch {
    return null
  }
}
