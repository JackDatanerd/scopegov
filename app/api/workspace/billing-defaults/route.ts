export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth/session'

// Read-only: the workspace's billing defaults (Settings → Workspace → Billing defaults) that
// pre-fill new invoices and change orders. Any signed-in member may read them — they are
// starting values for a form, not financial data — and the write path is
// PATCH /api/workspace/settings behind MANAGE_WORKSPACE_SETTINGS.
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const service = createServiceClient()
    const { data, error } = await (service as any)
      .from('workspaces')
      .select('default_tax_rate, default_tax_inclusive, default_payment_terms_days')
      .eq('id', session.workspaceId).single()
    if (error || !data) {
      console.error('Billing defaults load failed:', error)
      return NextResponse.json({ error: 'Failed to load billing defaults' }, { status: 500 })
    }
    // FIX (section-12 re-audit — bug): default_tax_rate defaults to 0 and
    // default_tax_inclusive defaults to true INDEPENDENTLY (migration 076) — so
    // every workspace that has never visited Settings → Billing defaults returned
    // taxInclusive: true here alongside a 0% rate. lib/documents/tax-defaults.ts's
    // workspaceTaxDefaults() (this same setting's other consumer, for change orders
    // created outside the editor) already treats "inclusive" as meaningless without
    // a configured, positive rate; this endpoint — which pre-fills the invoice AND
    // CO creation forms — never applied that same rule, and CreateInvoiceModal
    // (components/invoices/BillingTab.tsx) seeded its taxInclusive state straight
    // from this value with no rate check of its own. computeInvoiceTotals() now
    // forces taxInclusive false server-side whenever taxRate isn't positive
    // regardless of what a form sends, so this fix is belt-and-suspenders for
    // invoices — but it's the actual source of the wrong default for the CO editor,
    // which has no equivalent forcing step.
    const rate = Number(data.default_tax_rate) || 0
    return NextResponse.json({
      taxRate: rate,
      taxInclusive: rate > 0 ? (data.default_tax_inclusive ?? true) : false,
      paymentTermsDays: data.default_payment_terms_days ?? null,
    })
  } catch (err) {
    console.error('Billing defaults error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
