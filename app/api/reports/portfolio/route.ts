import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { parsePeriod } from '@/lib/reports/period'
import { getPortfolioData } from '@/lib/reports/portfolio-data'

// Portfolio dashboard is workspace-wide by definition — it has no
// per-project scoping, so it requires its own VIEW_PORTFOLIO permission
// (migration 057; previously VIEW_ALL_PROJECTS, which contradicted the
// public promise that the portfolio is "gated on its own permission").
// Client names are withheld without VIEW_CLIENT_DATA; money without
// VIEW_FINANCIALS.
//
// The actual data assembly (snapshot history + drill-down queries) now
// lives in lib/reports/portfolio-data.ts, shared with
// api/reports/portfolio/export/route.ts (CSV/PDF) — see the FIX note
// there for why.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'VIEW_PORTFOLIO'))
      return NextResponse.json({ error: 'Missing permission: VIEW_PORTFOLIO' }, { status: 403 })

    const canViewFinancials = hasPermission(session, 'VIEW_FINANCIALS')
    const canViewClients = hasPermission(session, 'VIEW_CLIENT_DATA')
    const { searchParams } = new URL(request.url)
    const period = parsePeriod(searchParams.get('period'))
    if (!period) return NextResponse.json({ error: 'Invalid period' }, { status: 400 })

    const service = createServiceClient()
    const data = await getPortfolioData(service, session.workspaceId, period, canViewFinancials, canViewClients)

    return NextResponse.json(data)
  } catch (err) {
    console.error('Portfolio report error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
