// lib/utils/workspace-guard.ts
//
// Stale-tab guard shared by every Settings write. The active workspace is stored per user on the server, so a tab
// left open from before another tab/device switched workspace would otherwise write onto whichever workspace is
// active NOW. When the caller says which workspace it believes it is editing, it must match the session's.

import { NextResponse } from 'next/server'

export function staleWorkspaceResponse(claimed: unknown, sessionWorkspaceId: string): NextResponse | null {
  if (typeof claimed !== 'string' || claimed === '' || claimed === sessionWorkspaceId) return null
  return NextResponse.json({
    error: 'You\u2019re no longer working on that workspace. Reload the page and try again.',
  }, { status: 409 })
}
