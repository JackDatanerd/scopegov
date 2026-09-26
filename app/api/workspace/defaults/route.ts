export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { diffFields, sameValue } from '@/lib/utils/audit-diff'
import { parseStandardsInput } from '@/lib/utils/agency-standards'
import { SOW_LANGUAGE_NAMES } from '@/lib/ai/sow-content'
import type { SessionUser } from '@/lib/supabase/types'

const PROJECT_TYPES = ['web', 'mobile', 'brand', 'ecomm', 'marketing', 'retainer', 'video', 'other'] as const
type ProjectType = typeof PROJECT_TYPES[number]

const PAYMENT_STRUCTURES = ['50_50', '100_upfront', 'milestones', 'monthly', 'on_delivery'] as const

// FIX (traced while verifying the Workspace lifecycle + Onboarding round —
// pre-existing, confirmed on unmodified HEAD, unrelated to this round's own
// changes): a route file may only export the specific fields Next.js's route
// type-checking recognizes (GET/POST/etc., runtime, config, ...) — exporting
// an arbitrary named constant from one broke `next build` entirely for the
// whole app. Only used within this file, so it doesn't need to be exported.
const REVISION_ROUNDS_MAX = 20
const GOVERNING_LAW_MAX = 200

// undefined = not specified (caller means "global"); null = explicitly global;
// a ProjectType = that override; 'invalid' = something else.
function normalizeProjectType(value: unknown): ProjectType | null | undefined | 'invalid' {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  return PROJECT_TYPES.includes(value as ProjectType) ? (value as ProjectType) : 'invalid'
}

class DefaultsValidationError extends Error {}

const SELECT_COLUMNS =
  'id, project_type, revision_rounds, payment_structure, governing_law, revision_policy, payment_terms, out_of_scope_clauses, assumptions, updated_at'

// One defaults row for a scope. Tolerates a legacy duplicate global row (older
// races could create several): the most recently updated one wins, and the
// caller is never handed an error for it.
async function findRow(service: any, workspaceId: string, projectType: ProjectType | null) {
  let query = service.from('workspace_defaults').select(SELECT_COLUMNS).eq('workspace_id', workspaceId)
  query = projectType ? query.eq('project_type', projectType) : query.is('project_type', null)
  const { data, error } = await query.order('updated_at', { ascending: false }).limit(1)
  if (error) throw new Error(`workspace_defaults lookup failed: ${error.message}`)
  return (data && data[0]) || null
}

function parseRevisionRounds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(n) || n < 0 || n > REVISION_ROUNDS_MAX) {
    throw new DefaultsValidationError(`Revision rounds must be a whole number from 0 to ${REVISION_ROUNDS_MAX}`)
  }
  return n
}

async function saveDefaults(workspaceId: string, body: any, actor: SessionUser) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DefaultsValidationError('Invalid request body')
  }
  const projectType = normalizeProjectType(body.projectType)
  if (projectType === 'invalid') {
    throw new DefaultsValidationError(`Invalid project type. Must be one of: ${PROJECT_TYPES.join(', ')}`)
  }
  const scope: ProjectType | null = projectType ?? null

  const { paymentStructure, governingLaw, sowLanguage } = body
  if (paymentStructure !== undefined && paymentStructure !== null && paymentStructure !== '' &&
      !PAYMENT_STRUCTURES.includes(paymentStructure)) {
    throw new DefaultsValidationError(`Invalid payment structure. Must be one of: ${PAYMENT_STRUCTURES.join(', ')}`)
  }
  const revisionRounds = parseRevisionRounds(body.revisionRounds)

  let governingLawValue: string | undefined
  if (governingLaw !== undefined && governingLaw !== null) {
    if (typeof governingLaw !== 'string') throw new DefaultsValidationError('Governing law must be text')
    governingLawValue = governingLaw.trim()
    if (governingLawValue.length > GOVERNING_LAW_MAX) {
      throw new DefaultsValidationError(`Governing law must be under ${GOVERNING_LAW_MAX} characters`)
    }
  }

  // FIX (fresh independent audit, section 4): mirrors the governingLaw handling just
  // above — sow_language is likewise a workspace-wide column (not per-project-type),
  // read by lib/ai/sow-content.ts on every generation. Validated against the same
  // closed set app/api/workspace/settings/route.ts already enforces (SOW_LANGUAGE_NAMES
  // in lib/ai/sow-content.ts is the set that actually has a translation), so this route
  // can't be used to write a code no generation path knows how to draft in.
  let sowLanguageValue: string | undefined
  if (sowLanguage !== undefined && sowLanguage !== null) {
    if (typeof sowLanguage !== 'string' || !(sowLanguage in SOW_LANGUAGE_NAMES)) {
      throw new DefaultsValidationError(`Unsupported SOW language. Must be one of: ${Object.keys(SOW_LANGUAGE_NAMES).join(', ')}`)
    }
    sowLanguageValue = sowLanguage
  }

  const standards = parseStandardsInput(body)
  if (!standards.ok) throw new DefaultsValidationError(standards.error)

  const service = createServiceClient() as any
  const existing = await findRow(service, workspaceId, scope)
  // FIX (deep audit, Settings + Team re-pass round 2 — MEDIUM): GET already
  // resolves an override field-by-field — own(), just below in this file —
  // falling back to the global row wherever the override's own field is
  // empty. pickAgencyStandards (used by SOW generation) does the identical
  // fallback. Both were defeated in practice: this route used to spread
  // `...standards.values` and set revision_rounds/payment_structure
  // unconditionally, so ANY save on an override scope wrote a full snapshot
  // of every field's then-CURRENT value, most of which the person never
  // touched — they'd only opened the form to change one thing. Once
  // written, that snapshot was indistinguishable from a deliberate override:
  // a later edit to the workspace-wide value silently stopped reaching that
  // project type's SOWs, with no way to tell from the UI that it had
  // "frozen." Fetch the global row (only needed for a scoped save — the
  // global row IS `existing` when scope is null) and, per field, store an
  // explicit NULL — "inherit" in both GET's and pickAgencyStandards's
  // fallback chains — whenever the submitted value matches what global
  // already resolves to. Genuinely different values still get stored,
  // and still take precedence, exactly as before.
  const globalDefaults = scope ? await findRow(service, workspaceId, null) : existing

  const payload: Record<string, unknown> = {
    workspace_id: workspaceId,
    project_type: scope,
    updated_at:   new Date().toISOString(),
  }
  for (const [key, value] of Object.entries(standards.values)) {
    const inheritsFromGlobal = !!scope && sameValue(value, (globalDefaults as Record<string, unknown> | null)?.[key] ?? null)
    payload[key] = inheritsFromGlobal ? null : value
  }
  if (revisionRounds !== undefined) {
    const inheritedRounds = globalDefaults?.revision_rounds ?? 2
    payload.revision_rounds = (scope && revisionRounds === inheritedRounds) ? null : revisionRounds
  } else if (!existing) {
    payload.revision_rounds = scope ? null : 2
  }
  const paymentStructureProvided = paymentStructure !== undefined && paymentStructure !== null && paymentStructure !== ''
  if (paymentStructureProvided) {
    const inheritedStructure = globalDefaults?.payment_structure ?? '50_50'
    payload.payment_structure = (scope && paymentStructure === inheritedStructure) ? null : paymentStructure
  } else if (!existing) {
    payload.payment_structure = scope ? null : '50_50'
  }
  if (!scope && governingLawValue !== undefined) payload.governing_law = governingLawValue || null

  // Persist. If two saves race to create the same row, the unique index makes
  // one insert fail; that one is retried as an update of the row that won.
  let saved = existing
  if (existing) {
    const { error } = await service.from('workspace_defaults').update(payload).eq('id', existing.id)
    if (error) {
      console.error('workspace_defaults update failed:', error)
      throw new Error('Could not save your defaults. Try again.')
    }
  } else {
    const { error } = await service.from('workspace_defaults').insert(payload)
    if (error) {
      if ((error as any).code !== '23505') {
        console.error('workspace_defaults insert failed:', error)
        throw new Error('Could not save your defaults. Try again.')
      }
      saved = await findRow(service, workspaceId, scope)
      if (!saved) throw new Error('Could not save your defaults. Try again.')
      const { error: retryErr } = await service.from('workspace_defaults').update(payload).eq('id', saved.id)
      if (retryErr) {
        console.error('workspace_defaults retry update failed:', retryErr)
        throw new Error('Could not save your defaults. Try again.')
      }
    }
  }

  // The workspace-wide governing law is also the value SOW generation reads
  // from the workspace row; keep the two in step.
  //
  // FIX (deep audit, Onboarding round — flagship finding): this used to gate
  // on `governingLawValue` being truthy, so clearing the field (submitting ''
  // to intentionally unset it) was indistinguishable from not sending it at
  // all — the workspace_defaults row correctly went back to NULL, but
  // workspaces.governing_law (the column sow/generate actually reads and
  // hard-blocks on) silently kept its last non-empty value forever. Anyone
  // who cleared it here believed they'd unset it — the wizard showed no
  // error — while SOW generation would go on quietly using the stale
  // jurisdiction instead of hard-blocking, exactly the silently-wrong-
  // jurisdiction failure this hard-block exists to prevent. Gate on the
  // field having been provided at all (`!== undefined`), not on it being
  // non-empty, and write through null exactly like the workspace_defaults
  // row already does two lines above this block.
  let previousGoverningLaw: string | null = null
  let governingLawChanged = false
  if (!scope && governingLawValue !== undefined) {
    const { data: ws } = await service.from('workspaces').select('governing_law').eq('id', workspaceId).single()
    previousGoverningLaw = ws?.governing_law ?? null
    const nextGoverningLaw = governingLawValue || null
    if (previousGoverningLaw !== nextGoverningLaw) {
      const { error: wsError } = await service
        .from('workspaces').update({ governing_law: nextGoverningLaw, updated_at: new Date().toISOString() }).eq('id', workspaceId)
      if (wsError) {
        console.error('workspaces.governing_law write-through failed:', wsError)
        throw new Error('Your defaults were saved, but the governing law could not be updated. Try again.')
      }
      governingLawChanged = true
    }
  }

  // FIX (fresh independent audit, section 4): same write-through as governing_law just
  // above, and for the same reason — sow_language lives on workspaces, not
  // workspace_defaults, and is what lib/ai/sow-content.ts actually reads at generation
  // time. Gated on the field having been provided at all, not on it being non-default,
  // so this can't repeat the governing-law bug where clearing a field was
  // indistinguishable from never sending it.
  let previousSowLanguage: string | null = null
  let sowLanguageChanged = false
  if (!scope && sowLanguageValue !== undefined) {
    const { data: ws } = await service.from('workspaces').select('sow_language').eq('id', workspaceId).single()
    previousSowLanguage = ws?.sow_language ?? null
    if (previousSowLanguage !== sowLanguageValue) {
      const { error: wsError } = await service
        .from('workspaces').update({ sow_language: sowLanguageValue, updated_at: new Date().toISOString() }).eq('id', workspaceId)
      if (wsError) {
        console.error('workspaces.sow_language write-through failed:', wsError)
        throw new Error('Your defaults were saved, but the SOW language could not be updated. Try again.')
      }
      sowLanguageChanged = true
    }
  }

  const before: Record<string, unknown> = {
    revisionRounds: existing?.revision_rounds, paymentStructure: existing?.payment_structure,
    revisionPolicy: existing?.revision_policy, paymentTerms: existing?.payment_terms,
    outOfScopeClauses: existing?.out_of_scope_clauses, assumptions: existing?.assumptions,
    governingLaw: previousGoverningLaw, sowLanguage: previousSowLanguage,
  }
  const after: Record<string, unknown> = {}
  if (payload.revision_rounds !== undefined)      after.revisionRounds = payload.revision_rounds
  if (payload.payment_structure !== undefined)    after.paymentStructure = payload.payment_structure
  if ('revision_policy' in payload)               after.revisionPolicy = payload.revision_policy
  if ('payment_terms' in payload)                 after.paymentTerms = payload.payment_terms
  if ('out_of_scope_clauses' in payload)          after.outOfScopeClauses = payload.out_of_scope_clauses
  if ('assumptions' in payload)                   after.assumptions = payload.assumptions
  if (governingLawChanged)                        after.governingLaw = governingLawValue || null
  if (sowLanguageChanged)                         after.sowLanguage = sowLanguageValue
  const { changedKeys, changes } = diffFields(before, after)

  if (changedKeys.length > 0 || !existing) {
    await logAudit(service, {
      workspaceId, actorId: actor.id,
      actorEmail: actor.email, actorName: actor.name,
      eventType: 'workspace.defaults_updated', entityType: 'workspace_defaults',
      entityId: workspaceId, entityName: scope || 'global',
      metadata: { projectType: scope || 'global', created: !existing, fields: changedKeys, changes },
    })
  }
}

async function authorised() {
  const session = await getSession()
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!hasPermission(session, 'MANAGE_WORKSPACE_SETTINGS')) {
    return { error: NextResponse.json({ error: 'Missing permission: MANAGE_WORKSPACE_SETTINGS' }, { status: 403 }) }
  }
  return { session }
}

async function handleSave(request: NextRequest, label: string) {
  try {
    const auth = await authorised()
    if (auth.error) return auth.error
    const body = await request.json().catch(() => null)
    // FIX (deep audit, Onboarding round — traced multi-tab/multi-session
    // staleness risk): this route (like branding and settings) deliberately
    // writes to session.workspaceId rather than any client-supplied ID, to
    // defeat a confused-deputy risk already hardened in the resume flow. But
    // nothing previously re-checked that the caller's own idea of which
    // workspace it's editing (the onboarding wizard's local `workspaceId`
    // state, sent here as body.workspaceId) still matched the session's
    // active workspace before writing. A second tab or device that changed
    // the session's active workspace mid-wizard (discarding it, restoring an
    // older one) could leave a stale first tab silently writing these
    // defaults onto whatever workspace the session fell back to instead.
    // When the caller does tell us which workspace it thinks it's editing,
    // require it to match — turning a silent misdirected write into a
    // visible, safe refusal — rather than only when it's simply absent.
    if (body && typeof body === 'object' && typeof body.workspaceId === 'string' &&
        body.workspaceId !== auth.session!.workspaceId) {
      return NextResponse.json({
        error: 'You\u2019re no longer working on that workspace. Reload the page and try again.',
      }, { status: 409 })
    }
    await saveDefaults(auth.session!.workspaceId, body, auth.session!)
    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof DefaultsValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    console.error(`Workspace defaults ${label} error:`, err)
    return NextResponse.json({ error: (err as Error)?.message?.startsWith('Could not') || (err as Error)?.message?.startsWith('Your defaults')
      ? (err as Error).message : 'Could not save your defaults. Try again.' }, { status: 500 })
  }
}

export async function POST(request: NextRequest)  { return handleSave(request, 'POST') }
export async function PATCH(request: NextRequest) { return handleSave(request, 'PATCH') }

export async function DELETE(request: NextRequest) {
  try {
    const auth = await authorised()
    if (auth.error) return auth.error
    const session = auth.session!

    const { searchParams } = new URL(request.url)
    const projectType = normalizeProjectType(searchParams.get('projectType'))
    if (!projectType || projectType === 'invalid') {
      return NextResponse.json({ error: 'projectType is required and must be a specific type (the global default cannot be deleted)' }, { status: 400 })
    }
    const service = createServiceClient() as any
    const { data: removed, error } = await service
      .from('workspace_defaults')
      .delete()
      .eq('workspace_id', session.workspaceId)
      .eq('project_type', projectType)
      .select('id')
    if (error) {
      console.error('Workspace defaults delete failed:', error)
      return NextResponse.json({ error: 'Could not remove that override. Try again.' }, { status: 500 })
    }

    if (removed && removed.length > 0) {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name,
        eventType: 'workspace.defaults_override_removed', entityType: 'workspace_defaults',
        entityId: session.workspaceId, entityName: projectType,
        metadata: { projectType },
      })
    }

    return NextResponse.json({ ok: true, removed: !!(removed && removed.length) })
  } catch (err) {
    console.error('Workspace defaults DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const service = createServiceClient() as any

    const { searchParams } = new URL(request.url)
    const requested = normalizeProjectType(searchParams.get('projectType') || undefined)
    if (requested === 'invalid') {
      return NextResponse.json({ error: `Invalid project type. Must be one of: ${PROJECT_TYPES.join(', ')}` }, { status: 400 })
    }

    const [globalDefaults, typeDefaults, { data: workspace }] = await Promise.all([
      findRow(service, session.workspaceId, null),
      requested ? findRow(service, session.workspaceId, requested) : Promise.resolve(null),
      service.from('workspaces').select('currency, governing_law, sow_language').eq('id', session.workspaceId).single(),
    ])

    // Standards mirror how SOW generation resolves them (see
    // lib/utils/agency-standards.ts's pickAgencyStandards, whose own comment
    // has the full story): an override's own value when it has ANY value —
    // including a deliberately blank string or empty list — else the
    // workspace-wide value. Only a column that's actually NULL (never
    // touched, or resolved identical to global at save time — see this
    // route's own POST/PATCH inheritsFromGlobal collapse) falls back.
    //
    // FIX (deep audit, Settings section — flagship finding): this used to
    // fall back whenever the override's own value was EMPTY rather than
    // NULL, so a project type deliberately cleared to have no standard
    // exclusions (say) silently showed the workspace-wide exclusions
    // instead — indistinguishable in this UI from the override never having
    // been touched, even though saving it is exactly what made isOverride
    // true. parseText/parseClauses no longer collapse a submitted '' or []
    // to null on the way in, so a real empty value now persists and is
    // honoured here rather than masked.
    const own = (field: string) => {
      if (!typeDefaults) return globalDefaults?.[field]
      const v = typeDefaults[field]
      return (v === null || v === undefined) ? globalDefaults?.[field] : v
    }

    return NextResponse.json({
      revisionRounds:    typeDefaults?.revision_rounds ?? globalDefaults?.revision_rounds ?? 2,
      paymentStructure:  typeDefaults?.payment_structure ?? globalDefaults?.payment_structure ?? '50_50',
      revisionPolicy:    own('revision_policy') ?? '',
      paymentTerms:      own('payment_terms') ?? '',
      outOfScopeClauses: own('out_of_scope_clauses') ?? [],
      assumptions:       own('assumptions') ?? [],
      governingLaw:      workspace?.governing_law ?? null,
      sowLanguage:       workspace?.sow_language ?? 'en',
      currency:          workspace?.currency ?? 'USD',
      isOverride:        !!typeDefaults,
      projectType:       requested || null,
    })
  } catch (err) {
    console.error('Workspace defaults GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
