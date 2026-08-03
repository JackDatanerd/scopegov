import { getSession, hasPermission } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import PortfolioDashboard from '@/components/portfolio/PortfolioDashboard'

export const metadata = { title: 'Portfolio' }

export default async function PortfolioPage() {
  const session = await getSession()
  if (!session) redirect('/login')

  if (!hasPermission(session, 'VIEW_ALL_PROJECTS')) {
    return (
      <div className="page">
        <h1 className="page-title">Portfolio</h1>
        <div className="surface surface-p" style={{ textAlign: 'center', padding: 48 }}>
          <i className="ti ti-lock" style={{ fontSize: 28, color: 'var(--text-4)', display: 'block', marginBottom: 12 }} />
          <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
            The portfolio view requires the VIEW_ALL_PROJECTS permission, since it rolls up scope
            risk across every project in the workspace.
          </p>
        </div>
      </div>
    )
  }

  return (
    <PortfolioDashboard
      canViewFinancials={hasPermission(session, 'VIEW_FINANCIALS')}
      agencyName={session.agencyName}
    />
  )
}
