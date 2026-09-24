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
    return NextResponse.json({
      taxRate: Number(data.default_tax_rate) || 0,
      taxInclusive: data.default_tax_inclusive ?? true,
      paymentTermsDays: data.default_payment_terms_days ?? null,
    })
  } catch (err) {
    console.error('Billing defaults error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
