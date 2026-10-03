// lib/auth/admin.ts
//
// Guard + audit-logging for the platform admin panel (app/(admin)/admin/*,
// app/api/admin/*). Entirely separate from the workspace-scoped
// roles/permissions system in lib/utils/permission-*.ts — this is about
// whether a real human (someone on the founder's own team) can see across
// every tenant, not about what a workspace member can do inside their own
// workspace.
//
// is_platform_admin has no API route that can set it (see migration 090's
// header) — the only way in is a direct SQL/service-role operation. This
// file only ever reads that flag.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
import { requireStepUpForCurrentUser } from '@/lib/auth/step-up'
import { headers as nextHeaders } from 'next/headers'
import { getClientIpFromHeaders } from '@/lib/utils/request-ip'

export interface AdminActor {
  id: string
  email: string
  name: string
}

export interface AdminGuardResult {
  actor: AdminActor
  service: ReturnType<typeof createServiceClient>
}

// Page-level guard (Server Components under app/(admin)/admin/*). Returns
// null when the caller isn't a signed-in platform admin — callers redirect.
// Deliberately does NOT distinguish "not signed in" from "signed in but not
// an admin" in its return value: a non-admin should see the same "you don't
// have access to this" outcome either way, and the distinction is already
// visible in application logs if it ever matters.
// True when the session has at least one verified TOTP factor. The global
// aal2-challenge gate in middleware.ts already forces any such session to
// have PASSED that challenge before reaching here — so "has a verified
// factor" is sufficient to know this request is genuinely aal2, without
// re-deriving assurance level here too. What middleware does NOT enforce
// per-permission is whether a factor exists at all (that's
// gate.must_enroll_mfa, computed from workspace role permissions, which
// knows nothing about is_platform_admin) — so admin access additionally
// requires enrollment itself, checked directly here.
function hasVerifiedMfaFactor(user: { factors?: Array<{ status: string }> } | null): boolean {
  return !!user?.factors?.some(f => f.status === 'verified')
}

export async function getAdminActor(): Promise<AdminActor | null> {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    if (!hasVerifiedMfaFactor(user as any)) return null

    const service = createServiceClient()
    const { data: row } = await (service as any)
      .from('users')
      .select('id, email, name, is_platform_admin, deleted_at')
      .eq('id', user.id)
      .maybeSingle()

    if (!row || row.deleted_at || !row.is_platform_admin) return null
    return { id: row.id, email: row.email, name: row.name || row.email }
  } catch (err) {
    console.error('[admin] getAdminActor threw:', err)
    return null
  }
}

// FIX (Auth+MFA independent pass 7 — MEDIUM): a platform admin with NO workspace
// membership (the support-account case this file's own header describes) could
// never satisfy hasVerifiedMfaFactor(): getAdminActor() refused them, the admin
// layout sent them to /dashboard, middleware bounced them from there to /onboarding,
// and /mfa-setup itself required a workspace session — so there was no route by
// which such an account could enrol the factor the admin panel demands.
// Returns { name } ONLY for a signed-in, non-deleted platform admin who has no
// verified factor yet — i.e. someone for whom "go and enrol" is the right answer and
// whose existence as an admin they already know. Everyone else gets null, so a
// non-admin still learns nothing about whether the admin surface exists.
export async function adminNeedsMfaEnrolment(): Promise<{ name: string } | null> {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || hasVerifiedMfaFactor(user as any)) return null

    const service = createServiceClient()
    const { data: row } = await (service as any)
      .from('users')
      .select('name, email, is_platform_admin, deleted_at')
      .eq('id', user.id)
      .maybeSingle()
    if (!row || row.deleted_at || !row.is_platform_admin) return null
    return { name: row.name || row.email || 'there' }
  } catch (err) {
    console.error('[admin] adminNeedsMfaEnrolment threw:', err)
    return null
  }
}

// Route-handler guard for app/api/admin/*. Returns a 403 NextResponse to
// return-as-is when the caller isn't an admin, or the actor + a service
// client to use for the rest of the handler. `requireStepUp` re-verifies a
// fresh password/TOTP check (lib/auth/step-up.ts, the same mechanism
// change-password/transfer-ownership use) for actions that mutate another
// tenant's data or another user's account — read-only admin routes
// (listing workspaces, viewing a user) don't need it.
export async function requireAdmin(opts?: { requireStepUp?: boolean }): Promise<
  AdminGuardResult | NextResponse
> {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  if (!hasVerifiedMfaFactor(user as any)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const service = createServiceClient()
  const { data: row } = await (service as any)
    .from('users')
    .select('id, email, name, is_platform_admin, deleted_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!row || row.deleted_at || !row.is_platform_admin) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (opts?.requireStepUp) {
    const stepUpFailure = await requireStepUpForCurrentUser()
    if (stepUpFailure) return stepUpFailure
  }

  return { actor: { id: row.id, email: row.email, name: row.name || row.email }, service }
}

function isGuardFailure(x: AdminGuardResult | NextResponse): x is NextResponse {
  return x instanceof NextResponse
}
export { isGuardFailure as isAdminGuardFailure }

export interface AdminAuditParams {
  actor: AdminActor
  eventType: string
  targetType: 'workspace' | 'user' | 'billing' | 'system'
  targetId?: string | null
  targetLabel?: string | null
  metadata?: Record<string, unknown>
}

// Same non-fatal-but-never-silent contract as lib/utils/audit.ts's
// logAudit(): a failed write here must not fail the admin's action, but
// must never vanish without a trace either.
//
// FIX (Admin panel independent audit — B12): a failed insert used to be a console.error and `false` that every
// caller dropped, so an action could succeed with no admin audit row, no alert and an "ok" response. It is now
// retried once, and if it still fails (a) the full row is written to the log as ONE structured line so it can be
// replayed by hand, and (b) ops is paged. Callers return the boolean to the panel as `auditLogged` so the admin
// sees the gap immediately.
async function insertAdminAudit(service: any, params: AdminAuditParams, ipAddress: string | undefined): Promise<string | null> {
  try {
    const { error } = await service.from('platform_admin_audit_log').insert({
      admin_id: params.actor.id,
      admin_email: params.actor.email,
      admin_name: params.actor.name,
      event_type: params.eventType,
      target_type: params.targetType,
      target_id: params.targetId || null,
      target_label: params.targetLabel || null,
      metadata: params.metadata || {},
      ip_address: ipAddress || null,
    })
    return error ? String(error.message ?? error) : null
  } catch (err: any) {
    return String(err?.message ?? err)
  }
}

export async function logAdminAction(service: any, params: AdminAuditParams): Promise<boolean> {
  let ipAddress: string | undefined
  try {
    ipAddress = getClientIpFromHeaders(nextHeaders())
  } catch {
    ipAddress = undefined
  }
  let failure = await insertAdminAudit(service, params, ipAddress)
  if (failure) {
    await new Promise(r => setTimeout(r, 200))
    failure = await insertAdminAudit(service, params, ipAddress)
  }
  if (!failure) return true

  console.error(`[admin-audit] insert failed for ${params.eventType}: ${failure}`)
  console.error('[admin-audit] UNRECORDED ADMIN ACTION ' + JSON.stringify({
    admin_id: params.actor.id, admin_email: params.actor.email, event_type: params.eventType,
    target_type: params.targetType, target_id: params.targetId ?? null, target_label: params.targetLabel ?? null,
    metadata: params.metadata ?? {}, ip_address: ipAddress ?? null, at: new Date().toISOString(),
  }))
  try {
    // Lazy import: keeps the e-mail stack out of every module that only needs the guard.
    const { alertBillingOps } = await import('@/lib/billing/ops-alert')
    await alertBillingOps(service, `admin-audit-write:${params.eventType}:${params.actor.id}`,
      'Platform admin action was NOT recorded in the admin audit log', [
        `admin: ${params.actor.email}`, `event: ${params.eventType}`,
        `target: ${params.targetType} ${params.targetId ?? '-'} ${params.targetLabel ?? ''}`,
        `error: ${failure}`,
        'The action itself succeeded. The full row is in the application log as "UNRECORDED ADMIN ACTION".',
      ])
  } catch (e) {
    console.error('[admin-audit] could not page ops about the unrecorded action:', e)
  }
  return false
}

// FIX (Admin panel independent audit — G2): reading another tenant's members, e-mails and billing was not
// recorded anywhere, although migration 090's own header lists "searched for email z" as an auditable action.
// Reads are logged too, but de-duplicated per (admin, event, target, label) inside `dedupeWithinMs` so a page
// refresh or a detail page that re-fetches does not bury the real actions. A failed de-dupe lookup logs anyway.
export async function logAdminRead(
  service: any, params: AdminAuditParams, opts: { dedupeWithinMs?: number } = {},
): Promise<boolean> {
  const windowMs = opts.dedupeWithinMs ?? 10 * 60_000
  try {
    let q = service.from('platform_admin_audit_log').select('id')
      .eq('admin_id', params.actor.id).eq('event_type', params.eventType)
      .gte('created_at', new Date(Date.now() - windowMs).toISOString())
    q = params.targetId ? q.eq('target_id', params.targetId) : q.is('target_id', null)
    if (params.targetLabel) q = q.eq('target_label', params.targetLabel)
    const { data, error } = await q.limit(1)
    if (!error && data && data.length > 0) return true
  } catch { /* fall through and log */ }
  return logAdminAction(service, params)
}

export interface AdminHistoryRow {
  id: string; admin_name: string; admin_email: string; event_type: string
  target_label: string | null; metadata: Record<string, unknown>; created_at: string
}

// FIX (Admin panel independent audit — G1): the audit log had no per-target view, so "what has been done to this
// account/workspace?" meant paging the global log. Views and searches are excluded (they are noise here).
export async function loadAdminHistory(
  service: any, targetType: 'workspace' | 'user', targetId: string, limit = 20,
): Promise<AdminHistoryRow[] | null> {
  try {
    const { data, error } = await service.from('platform_admin_audit_log')
      .select('id, admin_name, admin_email, event_type, target_label, metadata, created_at')
      .eq('target_type', targetType).eq('target_id', targetId)
      .not('event_type', 'like', '%.viewed')
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(limit)
    if (error) { console.error('[admin] history read failed:', error.message); return null }
    return data || []
  } catch (e) {
    console.error('[admin] history read threw:', e)
    return null
  }
}
