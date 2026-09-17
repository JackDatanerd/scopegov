import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { getPortfolioData } from '@/lib/reports/portfolio-data'

// Portfolio dashboard is workspace-wide by definition — it has no
// per-project scoping, so it requires VIEW_ALL_PROJECTS outright rather
// than falling back to a VIEW_OWN_PROJECTS-filtered view (BUG-058's
// distinction doesn't apply here; there's no "own" portfolio).
//
// The actual data assembly (snapshot history + drill-down queries) now
// lives in lib/reports/portfolio-data.ts, shared with
// api/reports/portfolio/export/route.ts (CSV/PDF) — see the FIX note
// there for why.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_ALL_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_ALL_PROJECTS' }, { status: 403 })

    const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')
    const { searchParams } = new URL(request.url)
    const period = searchParams.get('period') || '90d'

    const service = createServiceClient()
    const data = await getPortfolioData(service, session.workspaceId, period, canViewFinancials)

    return NextResponse.json(data)
  } catch (err) {
    console.error('Portfolio report error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
