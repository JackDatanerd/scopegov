import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { getScopeReportData, getFinancialReportData } from '@/lib/reports/scope-financial-data'
import { parsePeriod, periodSince } from '@/lib/reports/period'

export const maxDuration = 60

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // FIX (audit round 5): both modes below are workspace-wide rollups —
    // scope mode aggregates flags/exceptions/adjustments/amendments across
    // EVERY project in the workspace, financial mode does the same for
    // contract value/CO totals. /api/reports/portfolio already requires
    // VIEW_ALL_PROJECTS for exactly this reason (see its comments) —
    // this route was the one place that rollup logic existed without the
    // same gate, so a VIEW_OWN_PROJECTS-only member could pull scope and
    // financial data for projects they aren't assigned to.
    if (!hasPermission(session, 'VIEW_ALL_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: VIEW_ALL_PROJECTS' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('mode') || 'scope'
    if (mode !== 'scope' && mode !== 'financial')
      return NextResponse.json({ error: 'Invalid mode' }, { status: 400 })
    // Allowlisted — an unknown or inherited-key period ("foo", "constructor")
    // used to mean "all time" or a 500 respectively (see lib/reports/period.ts).
    const period = parsePeriod(searchParams.get('period'))
    if (!period) return NextResponse.json({ error: 'Invalid period' }, { status: 400 })
    const currencyParam = searchParams.get('currency')
    const requestedCurrency = currencyParam && /^[A-Za-z]{3}$/.test(currencyParam) ? currencyParam.toUpperCase() : null

    const service = createServiceClient()
    const since = periodSince(period)
    const wsId = session.workspaceId
    const canSeeFinancials = hasPermission(session, 'VIEW_FINANCIALS')

    if (mode === 'scope') {
      const data = await getScopeReportData(service, wsId, since, requestedCurrency, canSeeFinancials)
      return NextResponse.json(data)
    }

    // ── Financial mode ────────────────────────────────────────
    if (!canSeeFinancials)
      return NextResponse.json({ error: 'Missing permission: VIEW_FINANCIALS' }, { status: 403 })

    const data = await getFinancialReportData(service, wsId, since, requestedCurrency)
    return NextResponse.json(data)
  } catch (err) {
    // Log the real cause; don't hand raw database error text to the browser.
    console.error('Reports error:', err)
    return NextResponse.json({ error: 'Could not build the report' }, { status: 500 })
  }
}
