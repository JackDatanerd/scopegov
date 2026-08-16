// app/api/workspace/defaults/route.ts
// Fix 2 final: abandoned onConflict entirely. PostgREST partial unique index
// support is unreliable across Supabase versions. Explicit check-then-update
// works regardless of what constraints exist in the database.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

// FIX (doc-completeness audit, finding #1): governingLaw used to be
// stored ONLY on workspace_defaults, a table nothing in SOW generation
// ever reads — app/api/sow/generate/route.ts always read
// workspaces.governing_law instead. Every agency that set this during
// onboarding (where it defaulted to 'United States') got that value
// saved, displayed as saved, and then silently ignored by every SOW,
// which fell back to a hardcoded country instead. governing_law is now
// write-through: still recorded on workspace_defaults for callers that
// read the bundled defaults blob, but workspaces.governing_law — the
// column actually consulted at generation time — is the source of
// truth and gets updated in the same call. Callers that don't manage
// governing law (e.g. the Settings → Defaults tab, post-fix) simply
// omit governingLaw from the body and this leaves the workspace's
// value untouched rather than clobbering it with a default.
async function saveDefaults(workspaceId: string, body: any) {
  const { revisionRounds, paymentStructure, governingLaw } = body
  const service = createServiceClient()

  // Check if a global default row already exists for this workspace
  const { data: existing } = await (service as any)
    .from('workspace_defaults')
    .select('id')
    .eq('workspace_id', workspaceId)
    .is('project_type', null)
    .maybeSingle()

  const payload: Record<string, unknown> = {
    workspace_id:      workspaceId,
    project_type:      null,
    revision_rounds:   Number(revisionRounds) || 2,
    payment_structure: paymentStructure || '50_50',
    updated_at:        new Date().toISOString(),
  }
  if (governingLaw !== undefined) payload.governing_law = governingLaw || null

  if (existing?.id) {
    const { error } = await (service as any)
      .from('workspace_defaults')
      .update(payload)
      .eq('id', existing.id)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await (service as any)
      .from('workspace_defaults')
      .insert(payload)
    if (error) throw new Error(error.message)
  }

  // The write-through: this is the field SOW generation actually reads.
  if (governingLaw !== undefined && governingLaw !== null && String(governingLaw).trim() !== '') {
    const { error: wsError } = await (service as any)
      .from('workspaces')
      .update({ governing_law: String(governingLaw).trim() })
      .eq('id', workspaceId)
    if (wsError) throw new Error(wsError.message)
  }
}

// FIX (audit round 1): POST/PATCH had no permission gate — any workspace
// member could silently change workspace-wide contract defaults
// (revision rounds, payment structure, governing law) that get baked
// into every new project. Both writers now require
// MANAGE_WORKSPACE_SETTINGS. GET stays open to any member — reading your
// own workspace's defaults isn't sensitive, and the new-project wizard
// needs it regardless of role.
export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })
    }
    const body = await request.json()
    await saveDefaults(session.workspaceId, body)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })
    }
    const body = await request.json()
    await saveDefaults(session.workspaceId, body)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

// FIX: no GET handler existed at all — the new-project wizard's payment
// structure, revision rounds, and currency fields were hardcoded useState
// initial values ('50_50', 2, 'USD') with nothing fetching the saved
// workspace defaults, so every new project silently ignored whatever was
// configured in Settings → Defaults. Currency itself isn't a
// workspace_defaults column — it lives on workspaces — so it's included
// here too rather than requiring a second round trip.
export async function GET() {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()

    const [{ data: defaults }, { data: workspace }] = await Promise.all([
      (service as any)
        .from('workspace_defaults')
        .select('revision_rounds, payment_structure')
        .eq('workspace_id', session.workspaceId)
        .is('project_type', null)
        .maybeSingle(),
      (service as any)
        .from('workspaces')
        .select('currency, governing_law')
        .eq('id', session.workspaceId)
        .single(),
    ])

    return NextResponse.json({
      revisionRounds:   defaults?.revision_rounds ?? 2,
      paymentStructure: defaults?.payment_structure ?? '50_50',
      // FIX (doc-completeness audit, finding #1): read from workspaces,
      // the column SOW generation actually consults, not
      // workspace_defaults — see saveDefaults() above for the full story.
      governingLaw:     workspace?.governing_law ?? null,
      currency:         workspace?.currency ?? 'USD',
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
