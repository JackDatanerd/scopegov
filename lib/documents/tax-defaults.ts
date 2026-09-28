// lib/documents/tax-defaults.ts
//
// Workspace billing defaults (Settings → Workspace → Billing defaults) for a NEW change order's tax terms.
// The CO editor applies them client-side from /api/workspace/billing-defaults; a CO created any other way —
// straight from a Guardian flag, or by an API caller that states no tax terms — never got them and always
// started at 0%. Same rule as the editor: only a configured, positive rate is applied.

export async function workspaceTaxDefaults(service: any, workspaceId: string): Promise<{ taxRate: number; taxInclusive: boolean }> {
  try {
    const { data } = await service.from('workspaces')
      .select('default_tax_rate, default_tax_inclusive').eq('id', workspaceId).single()
    const rate = Number(data?.default_tax_rate) || 0
    if (rate > 0 && rate <= 100) return { taxRate: rate, taxInclusive: data?.default_tax_inclusive ?? true }
  } catch { /* fall through to no tax */ }
  return { taxRate: 0, taxInclusive: false }
}
