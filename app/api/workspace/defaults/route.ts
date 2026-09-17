// app/api/workspace/defaults/route.ts
// Fix 2 final: abandoned onConflict entirely. PostgREST partial unique index
// support is unreliable across Supabase versions. Explicit check-then-update
// works regardless of what constraints exist in the database.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

// FIX (deep audit, section 5 re-pass): workspace_defaults was designed
// from the start as a per-project-type table — see the 8-column,
// UNIQUE(workspace_id, project_type) schema in
// supabase/migrations/001_initial_schema.sql, deliberately mirroring the
// same per-type pattern sow_templates already uses. In practice every
// caller (this route, the Settings → Defaults tab, the new-project
// wizard) only ever touched the single project_type IS NULL row — the
// per-type rows were entirely unreachable. This closes that gap for the
// two columns actually consumed anywhere downstream (revision_rounds,
// payment_structure; see app/(app)/projects/new/page.tsx). The other six
// designed columns (revision_policy, payment_terms, out_of_scope_clauses,
// assumptions, payment_split — plus governing_law, which lives on
// `workspaces` and is intentionally workspace-wide, not per-type) stay
// unused: nothing in SOW generation reads them, so building UI for them
// now would just create a second, differently-shaped half-built feature
// instead of finishing this one. If SOW generation ever grows to consume
// them, they can be added here the same way.
const PROJECT_TYPES = ['web', 'mobile', 'brand', 'ecomm', 'marketing', 'retainer', 'video', 'other'] as const
type ProjectType = typeof PROJECT_TYPES[number]

function normalizeProjectType(value: unknown): ProjectType | null | undefined {
  if (value === undefined) return undefined       // not specified → caller means "global"
  if (value === null || value === '') return null // explicitly global
  return PROJECT_TYPES.includes(value as ProjectType) ? (value as ProjectType) : undefined
}

// FIX (deep audit, Workspace lifecycle + Onboarding re-pass): saveDefaults
// used to throw new Error(error.message) / new Error(wsError.message) for
// real DB failures, indistinguishable from its own deliberate, safe
// validation message (invalid project type) — every catch block below
// then returned whichever kind it got straight to the client, the same
// info-disclosure pattern already fixed for every one of the seven named
// workspace-lifecycle routes. Tag validation errors so callers can tell
// the two apart: a DefaultsValidationError's message is always safe to
// show (and belongs on a 400); anything else is logged server-side and
// answered with a generic message on a 500 — including a bonus fix along
// the way, since an invalid project type previously fell through to the
// generic 500 catch instead of the 400 its own message implied.
class DefaultsValidationError extends Error {}

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
  const projectType = normalizeProjectType(body.projectType)
  if (projectType === undefined && body.projectType !== undefined) {
    throw new DefaultsValidationError(`Invalid project type. Must be one of: ${PROJECT_TYPES.join(', ')}`)
  }
  const service = createServiceClient()

  // Check if a default row already exists for this workspace + type
  // (project_type null = the global/workspace-wide row).
  let query = (service as any)
    .from('workspace_defaults')
    .select('id')
    .eq('workspace_id', workspaceId)
  query = projectType ? query.eq('project_type', projectType) : query.is('project_type', null)
  const { data: existing } = await query.maybeSingle()

  const payload: Record<string, unknown> = {
    workspace_id:      workspaceId,
    project_type:      projectType || null,
    revision_rounds:   Number(revisionRounds) || 2,
    payment_structure: paymentStructure || '50_50',
    updated_at:        new Date().toISOString(),
  }
  // Governing law is workspace-wide (lives on `workspaces`, not
  // per-project-type) — a per-type save never touches it, even if it's
  // present in the body, so a type-specific form can't accidentally
  // clobber the workspace's actual legal jurisdiction.
  if (!projectType && governingLaw !== undefined) payload.governing_law = governingLaw || null

  if (existing?.id) {
    const { error } = await (service as any)
      .from('workspace_defaults')
      .update(payload)
      .eq('id', existing.id)
    if (error) {
      console.error('workspace_defaults update failed:', error)
      throw new Error('Could not save your defaults. Try again.')
    }
  } else {
    const { error } = await (service as any)
      .from('workspace_defaults')
      .insert(payload)
    if (error) {
      console.error('workspace_defaults insert failed:', error)
      throw new Error('Could not save your defaults. Try again.')
    }
  }

  // The write-through: this is the field SOW generation actually reads.
  if (!projectType && governingLaw !== undefined && governingLaw !== null && String(governingLaw).trim() !== '') {
    const { error: wsError } = await (service as any)
      .from('workspaces')
      .update({ governing_law: String(governingLaw).trim() })
      .eq('id', workspaceId)
    if (wsError) {
      console.error('workspaces.governing_law write-through failed:', wsError)
      throw new Error('Could not save your governing law. Try again.')
    }
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
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): raw
    // exception messages (including raw Postgres errors passed straight
    // through by saveDefaults) used to reach the client here — see
    // DefaultsValidationError's own comment above for the full story.
    if (err instanceof DefaultsValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error('Workspace defaults POST error:', err)
    return NextResponse.json({ error: 'Could not save your defaults. Try again.' }, { status: 500 })
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
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): same
    // leak, same fix, as POST above.
    if (err instanceof DefaultsValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error('Workspace defaults PATCH error:', err)
    return NextResponse.json({ error: 'Could not save your defaults. Try again.' }, { status: 500 })
  }
}

// FIX (deep audit, section 5 re-pass): lets a workspace remove a
// project-type override and fall back to the global default again,
// without having to know what the global values are and re-POST them
// manually. Global (project_type null) can't be deleted this way — that
// row always exists as the fallback everything else resolves against.
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
      return NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 })
    }
    const { searchParams } = new URL(request.url)
    const projectType = normalizeProjectType(searchParams.get('projectType'))
    if (!projectType) {
      return NextResponse.json({ error: 'projectType is required and must be a specific type (the global default cannot be deleted)' }, { status: 400 })
    }
    const service = createServiceClient()
    const { error } = await (service as any)
      .from('workspace_defaults')
      .delete()
      .eq('workspace_id', session.workspaceId)
      .eq('project_type', projectType)
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): raw
    // Postgres error.message was returned straight to the client — same
    // pattern already fixed for every other write in this route.
    if (error) {
      console.error('Workspace defaults delete failed:', error)
      return NextResponse.json({ error: 'Could not remove that override. Try again.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Workspace defaults DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// FIX: no GET handler existed at all — the new-project wizard's payment
// structure, revision rounds, and currency fields were hardcoded useState
// initial values ('50_50', 2, 'USD') with nothing fetching the saved
// workspace defaults, so every new project silently ignored whatever was
// configured in Settings → Defaults. Currency itself isn't a
// workspace_defaults column — it lives on workspaces — so it's included
// here too rather than requiring a second round trip.
//
// FIX (deep audit, section 5 re-pass): now accepts ?projectType=; when
// given, looks up that type's override row and falls back field-by-field
// to the global row for anything the override doesn't set. `isOverride`
// tells the caller (the Defaults tab, and now the new-project wizard)
// whether what it got back is a real type-specific customization or just
// the global default surfacing through.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient()

    const { searchParams } = new URL(request.url)
    const requestedType = normalizeProjectType(searchParams.get('projectType') || undefined)
    if (requestedType === undefined && searchParams.get('projectType')) {
      return NextResponse.json({ error: `Invalid project type. Must be one of: ${PROJECT_TYPES.join(', ')}` }, { status: 400 })
    }

    const [{ data: globalDefaults }, { data: typeDefaults }, { data: workspace }] = await Promise.all([
      (service as any)
        .from('workspace_defaults')
        .select('revision_rounds, payment_structure')
        .eq('workspace_id', session.workspaceId)
        .is('project_type', null)
        .maybeSingle(),
      requestedType
        ? (service as any)
            .from('workspace_defaults')
            .select('revision_rounds, payment_structure')
            .eq('workspace_id', session.workspaceId)
            .eq('project_type', requestedType)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      (service as any)
        .from('workspaces')
        .select('currency, governing_law')
        .eq('id', session.workspaceId)
        .single(),
    ])

    return NextResponse.json({
      revisionRounds:   typeDefaults?.revision_rounds ?? globalDefaults?.revision_rounds ?? 2,
      paymentStructure: typeDefaults?.payment_structure ?? globalDefaults?.payment_structure ?? '50_50',
      // FIX (doc-completeness audit, finding #1): read from workspaces,
      // the column SOW generation actually consults, not
      // workspace_defaults — see saveDefaults() above for the full story.
      governingLaw:     workspace?.governing_law ?? null,
      currency:         workspace?.currency ?? 'USD',
      isOverride:       !!typeDefaults,
      projectType:      requestedType || null,
    })
  } catch (err) {
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): same
    // leak, same fix, as the write handlers above.
    console.error('Workspace defaults GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
