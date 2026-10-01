// components/workspace/WorkspaceOpenClient.tsx
'use client'
import { useEffect, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

// FIX (deep audit, Workspace lifecycle + Onboarding re-pass — round 2,
// minor): see app/(app)/workspace-open/page.tsx's own comment for the
// full story. Kept deliberately dumb — one POST, one redirect, no error
// UI worth building for a link whose entire job is to save one click in
// the workspace switcher. A failed switch (stale link, membership
// revoked again since the email went out) just lands on /dashboard as if
// this page were never visited, same as clicking the CTA used to do
// before this fix existed.
function WorkspaceOpenInner() {
  const searchParams = useSearchParams()
  const id = searchParams.get('id')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    ;(async () => {
      if (id) {
        try {
          await fetch('/api/workspace/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: id }),
          })
        } catch { /* best-effort — fall through to /dashboard regardless */ }
      }
      // FIX (Workspace lifecycle independent pass 5 — B1): this was router.replace('/dashboard'), a soft
      // navigation. This page lives inside the (app) layout, which was already rendered for the
      // PREVIOUS active workspace, and Next does not re-render a shared layout on a soft navigation —
      // so <Sidebar> and <CommandPalette> kept the old workspace's name, logo, plan and permissions
      // while the dashboard body showed the new one, until a hard reload. Sidebar.switchWorkspace and
      // restoreWorkspace already use a full navigation for exactly this reason; this was the one switch
      // call site that didn't. replace() (not assign) so Back doesn't return to this transient page.
      window.location.replace('/dashboard')
    })()
  }, [id])

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#6b7280', fontSize: 14 }}>
      Opening workspace…
    </div>
  )
}

export default function WorkspaceOpenClient() {
  return (
    <Suspense fallback={<div style={{ minHeight: '60vh' }} />}>
      <WorkspaceOpenInner />
    </Suspense>
  )
}
