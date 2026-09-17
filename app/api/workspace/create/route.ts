import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { nanoid } from 'nanoid'
import crypto from 'crypto'
import { sanitizeDisplayName } from '@/lib/utils/sanitize'
import { INDUSTRIES, CURRENCIES, TIMEZONES } from '@/lib/constants/workspace-options'
import { sendWorkspaceCreatedEmail } from '@/lib/email/templates'

function generateSlug(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40) + '-' + nanoid(6)
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { agencyName: agencyNameRaw, industry, currency, timezone } = await request.json()
    const agencyName = sanitizeDisplayName(agencyNameRaw)
    if (!agencyName || !industry) {
      return NextResponse.json({ error: 'Agency name and industry are required' }, { status: 400 })
    }
    // FIX (Workspace lifecycle, round 4): industry was only truthy-checked
    // (any string accepted), and currency/timezone were accepted verbatim
    // with no validation at all — the UI presents fixed dropdowns for all
    // three, but nothing stopped a direct API call from storing an
    // unrecognized industry, an invalid currency code, or a bogus
    // timezone. No DB constraint backs any of these either. Validate
    // against the same curated lists the wizard offers.
    if (!(INDUSTRIES as readonly string[]).includes(industry)) {
      return NextResponse.json({ error: 'Invalid industry' }, { status: 400 })
    }
    if (currency !== undefined && currency !== null && !(CURRENCIES as readonly string[]).includes(currency)) {
      return NextResponse.json({ error: 'Invalid currency' }, { status: 400 })
    }
    if (timezone !== undefined && timezone !== null && !(TIMEZONES as readonly string[]).includes(timezone)) {
      return NextResponse.json({ error: 'Invalid timezone' }, { status: 400 })
    }

    // Use service client for workspace creation (bypasses RLS — BUG-002)
    const service = createServiceClient()

    const jwtSecret = crypto.randomBytes(32).toString('hex')
    const workspaceId = crypto.randomUUID()
    const slug = generateSlug(agencyName)

    // ── Atomic workspace creation (spec §1.0) ─────────────────────────────
    // workspace INSERT + workspace_members INSERT must succeed together or not at all
    // Supabase JS doesn't have multi-statement transactions, so we use RPC

    const { error: rpcError } = await (service as any).rpc('create_workspace_atomic', {
      p_workspace_id: workspaceId,
      p_user_id: user.id,
      p_name: agencyName,
      p_slug: slug,
      p_agency_name: agencyName,
      p_industry: industry,
      p_currency: currency || 'USD',
      p_timezone: timezone || 'Africa/Nairobi',
      p_jwt_secret: jwtSecret,
    })

    if (rpcError) {
      // FIX (section-by-section re-audit): migration 019 adds
      // one_active_trial_per_creator, a partial unique index blocking a
      // second active trial workspace for the same creator (there was no
      // cap at all before — a user could reset their 14-day trial
      // indefinitely by just creating a new workspace whenever the old
      // one expired). Surface that specific conflict with a real message
      // instead of the generic failure below.
      if (rpcError.code === '23505' && String(rpcError.message || '').includes('one_active_trial_per_creator')) {
        return NextResponse.json({
          error: 'You already have an active trial workspace. Upgrade it, delete it, or contact support@scopegov.app to start another trial.',
        }, { status: 409 })
      }
      // FIX (re-audit, minor finding): raw Postgres error message/code/hint
      // was returned straight to the browser — fine for local debugging,
      // but an information-disclosure leftover for production. Log server-side
      // only now.
      console.error('create_workspace_atomic failed:', JSON.stringify(rpcError))
      return NextResponse.json({
        error: 'Failed to create workspace',
      }, { status: 500 })
    }

    // FIX (section-by-section re-audit, Workspace lifecycle Finding 5):
    // this used to unconditionally overwrite name/email from
    // user.user_metadata (the ORIGINAL signup-time value, which never
    // changes) on every workspace creation — not just the first. A user
    // who renamed themselves via workspace/profile/route.ts after signup
    // and later created a SECOND workspace got their name silently
    // reverted. handle_new_user() (migration 001) already guarantees a
    // users row exists by the time an authenticated request reaches
    // here, so this only ever needs to set active_workspace_id.
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): also
    // read back the canonical `name` here (one round trip) rather than
    // falling back to user.user_metadata?.name below — see the
    // audit-log insert's own comment for why that fallback is stale.
    const { data: userRow, error: activeWsError } = await (service as any)
      .from('users')
      .update({ active_workspace_id: workspaceId })
      .eq('id', user.id)
      .select('name')
      .maybeSingle()
    if (activeWsError) console.error('Failed to set active_workspace_id after create (non-fatal):', activeWsError)

    // FIX (section-by-section re-audit, Workspace lifecycle Finding 3):
    // this audit-log insert wasn't wrapped in its own try/catch, so a
    // transient failure here (a network blip is enough — Supabase's
    // query builder doesn't throw on a DB-level error, but does on a
    // network-level one) turned an ALREADY-successful atomic workspace
    // creation into a client-facing 500. Combined with no cap on
    // workspace creation (now fixed above) and no retry-idempotency, a
    // client retrying on that spurious 500 would create a second,
    // fully duplicate, orphaned trial workspace. Non-fatal now, matching
    // every other audit-log call in this codebase.
    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass): this
    // used user.user_metadata?.name — the ORIGINAL signup-time value,
    // set once and never updated by workspace/profile's rename (that
    // route only ever writes public.users.name, never Auth metadata) —
    // falling all the way back to the full email address instead of
    // handle_new_user()'s own canonical fallback (the email's local
    // part, migration 019). Every other audit_log call in this codebase
    // sources actorName from the current users.name/session.name; this
    // was the one place in workspace/create that didn't, even though
    // it's the very first line in a new workspace's trail.
    try {
      const { error: auditError } = await (service as any).from('audit_log').insert({
        workspace_id: workspaceId,
        actor_id: user.id,
        actor_email: user.email,
        actor_name: userRow?.name || user.user_metadata?.name || user.email,
        event_type: 'workspace.created',
        entity_type: 'workspace',
        entity_id: workspaceId,
        entity_name: agencyName,
        metadata: { plan: 'trial' },
      })
      if (auditError) console.error('workspace.created audit log insert failed (non-fatal):', auditError)
    } catch (e) { console.error('workspace.created audit log insert threw (non-fatal):', e) }

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — feature
    // gap): see sendWorkspaceCreatedEmail's own comment in
    // lib/email/templates.ts. Best-effort, same as the audit-log insert
    // above and sendWorkspaceDeletedEmail's own call site — must never
    // fail an already-successful workspace creation.
    if (user.email) {
      await sendWorkspaceCreatedEmail({
        to: user.email, name: userRow?.name || user.email, agencyName,
      }).catch(e => console.error('Workspace created email failed (non-fatal):', e))
    }

    return NextResponse.json({ workspaceId, slug })
  } catch (err) {
    console.error('Workspace create error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
