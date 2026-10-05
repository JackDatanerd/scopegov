// lib/documents/tax-defaults.ts
//
// Workspace billing defaults (Settings → Workspace → Billing defaults) for a NEW change order's tax terms.
// The CO editor applies them client-side from /api/workspace/billing-defaults; a CO created any other way —
// straight from a Guardian flag, or by an API caller that states no tax terms — never got them and always
// started at 0%. Same rule as the editor: only a configured, positive rate is applied.
//
// supabase-js never throws: a failed read resolves to { data: null, error }. That used to read as "no default
// configured" and silently created the change order at 0% tax. `strict` makes a failed read THROW so a caller that
// can still refuse (POST /api/co, before it claims anything) answers a retryable 500; the lenient default stays for
// a caller that has already claimed a flag (a throw there would strand it) and now logs the failure.

export async function workspaceTaxDefaults(
  service: any, workspaceId: string, opts: { strict?: boolean } = {},
): Promise<{ taxRate: number; taxInclusive: boolean }> {
  const { data, error } = await service.from('workspaces')
    .select('default_tax_rate, default_tax_inclusive').eq('id', workspaceId).single()
  if (error) {
    if (opts.strict) throw new Error(`workspace tax defaults lookup failed: ${error.message}`)
    console.error('workspace tax defaults lookup failed (falling back to no tax):', error.message)
    return { taxRate: 0, taxInclusive: false }
  }
  const rate = Number(data?.default_tax_rate) || 0
  if (rate > 0 && rate <= 100) return { taxRate: rate, taxInclusive: data?.default_tax_inclusive ?? true }
  return { taxRate: 0, taxInclusive: false }
}
