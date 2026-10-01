'use client'

// FIX (Auth+MFA pass 9): pages call getSessionStrict() (lib/auth/session.ts), which throws
// SessionUnavailableError on a transient database/Auth failure instead of answering "signed out" — that
// used to bounce a signed-in person around /login <-> /dashboard. This is the retryable screen they get
// now. It also catches any other unexpected render error below the root layout.

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="auth-root">
      <div className="auth-form-side" style={{ width: '100%' }}>
        <div className="auth-form-wrap" style={{ textAlign: 'center' }}>
          <h2 className="auth-form-title" style={{ textAlign: 'center' }}>Something went wrong</h2>
          <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.7, margin: '8px 0 24px' }}>
            We couldn&apos;t load this page just now. You&apos;re still signed in — please try again.
          </p>
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px' }} onClick={() => reset()}>
            Try again
          </button>
        </div>
      </div>
    </div>
  )
}
