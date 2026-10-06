import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getSessionStrict, hasPermission } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { loadRoiInputs } from '@/lib/billing/roi-inputs'
import PlanCalculator from '@/components/calculator/PlanCalculator'

export const metadata = { title: 'What is scope creep costing you? · ScopeGov' }
export const maxDuration = 60

// Signed-in scope-loss calculator, prefilled from the workspace's own numbers. Open to anyone who may choose a plan
// (MANAGE_BILLING) or read the money (VIEW_FINANCIALS). The workspace's own figures are only loaded for people who may
// see the Reports rollup (VIEW_ALL_PROJECTS + VIEW_FINANCIALS); everyone else gets the manual calculator.
// It stays reachable on a read-only (lapsed) workspace — those permissions survive the lapse by design.
export default async function PlanCalculatorPage() {
  const session = await getSessionStrict()
  if (!session) redirect('/login')

  const canBill = hasPermission(session, 'MANAGE_BILLING')
  const canSeeMoney = hasPermission(session, 'VIEW_FINANCIALS') && hasPermission(session, 'VIEW_ALL_PROJECTS')
  if (!canBill && !hasPermission(session, 'VIEW_FINANCIALS')) {
    return (
      <div className="page" style={{ maxWidth: 640 }}>
        <h1 className="page-title">Plan calculator</h1>
        <p className="page-sub">You need billing or financial access to use this. Ask a workspace admin, or <Link href="/dashboard">go back to the dashboard</Link>.</p>
      </div>
    )
  }

  const service = createServiceClient()
  let load: Awaited<ReturnType<typeof loadRoiInputs>> = { measured: null, defaults: {} }
  let loadFailed = false
  try {
    const { data: ws } = await service.from('workspaces').select('created_at').eq('id', session.workspaceId).maybeSingle()
    load = await loadRoiInputs(service, session.workspaceId, { canSeeMoney, workspaceCreatedAt: ws?.created_at ?? null })
  } catch (e) {
    // A failed read must not look like "you have no data": say so, and fall back to the manual calculator.
    console.error('[plan-calculator] loading workspace numbers failed:', e)
    loadFailed = true
  }

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      {loadFailed && (
        <div className="banner banner-warn"><span>We couldn&rsquo;t load your workspace&rsquo;s numbers just now, so the calculator is blank. Refresh to try again, or enter your own figures.</span></div>
      )}
      <PlanCalculator mode="app" measured={load.measured} defaults={load.defaults} canManageBilling={canBill} />
    </div>
  )
}
