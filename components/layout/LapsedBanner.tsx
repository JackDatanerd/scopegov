import Link from 'next/link'

// The app-wide notice on a read-only (lapsed) workspace: a trial or subscription that has ended, or a non-payment
// downgrade. It is the moment someone decides whether to pay, not an error, so it is a calm card — what happened, that
// nothing is lost, and one clear next step — rather than a red alert strip. Rendered by app/(app)/layout.tsx.
export default function LapsedBanner({ canManageBilling }: { canManageBilling: boolean }) {
  return (
    <div className="lapsed-card" role="status">
      <span className="lapsed-card-icon" aria-hidden="true"><i className="ti ti-lock" /></span>
      <div className="lapsed-card-body">
        <div className="lapsed-card-title">This workspace is read-only</div>
        <p className="lapsed-card-text">
          {canManageBilling
            ? 'Your trial or subscription has ended. Everything is safe — you can still view and export all of it. Choose a plan to create and send again.'
            : 'Your trial or subscription has ended. Everything is safe and can still be viewed and exported. Ask a workspace admin with billing access to choose a plan.'}
        </p>
      </div>
      {canManageBilling && (
        <div className="lapsed-card-actions">
          <Link href="/plan-calculator" className="lapsed-card-link">See what a plan would recover</Link>
          <Link href="/settings?tab=billing" className="btn btn-primary btn-sm">Choose a plan</Link>
        </div>
      )}
    </div>
  )
}
