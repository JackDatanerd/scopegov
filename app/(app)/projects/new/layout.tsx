// app/(app)/projects/new/layout.tsx
//
// The wizard page is a client component with no permission awareness, and creating a project
// (POST /api/projects) requires CREATE_PROJECTS. Every in-app link to it is gated on that
// permission, but the URL itself wasn't: a member without it could open /projects/new directly,
// fill in the whole Basics step, and only learn it was pointless from a 403 on Continue.
// Redirect them to the projects list instead (same fallback the other permission-gated pages use).

import { redirect } from 'next/navigation'
import { getSessionStrict, hasPermission } from '@/lib/auth/session'

export default async function NewProjectLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionStrict()
  if (!session) redirect('/login')
  if (!hasPermission(session, 'CREATE_PROJECTS')) redirect('/projects')
  return <>{children}</>
}
