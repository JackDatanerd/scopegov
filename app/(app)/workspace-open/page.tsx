// app/(app)/workspace-open/page.tsx
//
// FIX (deep audit, Workspace lifecycle + Onboarding re-pass — round 2,
// minor): restore_workspace_atomic (migration 065) deliberately only
// repoints active_workspace_id for the person who ran the restore — a
// reactivated member who'd moved on to a different workspace as their
// daily-driver in the interim isn't yanked back somewhere they didn't
// choose to go. That left sendWorkspaceRestoredEmail's "Open workspace →"
// CTA, for every recipient EXCEPT the restorer, pointing at plain
// /dashboard — which resolves to whatever workspace is already active for
// them, not the one the email is about. This page is the one-click fix:
// it switches the signed-in user into the workspace named by ?id (the
// same /api/workspace/switch route the in-app switcher already uses,
// which itself already verifies real active membership before writing
// anything), then lands on /dashboard for real. If the switch can't
// complete for any reason — membership revoked again in the meantime,
// workspace re-deleted, a transient error — it fails soft into /dashboard
// anyway rather than stranding the user on an error page for what is,
// worst case, a bookmark-quality link.
//
// Requires an authenticated session (redirect('/login') mirrors every
// other page in this route group) but deliberately does NOT require the
// CURRENT active workspace to be onboarding-complete the way the rest of
// this group's layout might otherwise assume — a workspace that was live
// enough to be deleted and restored has already finished onboarding by
// definition, but the user's own currently-active fallback workspace is
// what /api/workspace/switch itself checks membership against, not this
// page.

import { getSession } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import WorkspaceOpenClient from '@/components/workspace/WorkspaceOpenClient'

export const metadata = { title: 'Opening workspace…' }

export default async function WorkspaceOpenPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  return <WorkspaceOpenClient />
}
