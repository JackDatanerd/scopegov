import type { Metadata } from 'next'

// signup/page.tsx is a client component and cannot export metadata, so the page's title, description and canonical URL
// live on this pass-through layout (no markup of its own — the page renders exactly as before).
export const metadata: Metadata = {
  title: 'Create your account',
  description: 'Create a ScopeGov account. Guardian reads every client email against your signed Statement of Work, flags what is out of scope, and drafts the change order.',
  alternates: { canonical: '/signup' },
}

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children
}
