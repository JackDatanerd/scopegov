// lib/auth/mfa-policy.ts
//
// Single source of truth for "which permissions make MFA mandatory."
// Deliberately a fixed constant, not a workspace-configurable setting —
// see the note at the bottom of supabase/migrations/006_mfa_backup_codes.sql
// (FIX, cosmetic, deep audit Auth+MFA re-pass: this cited the file's old,
// pre-renumbering name — the file itself has always been 006.)
// for why. If Phase 3 (approval chains) ships APPROVE_DOCUMENTS, add it
// here and enforcement picks it up everywhere automatically — middleware,
// the settings compliance panel, and the team roster badge all read from
// this one list.

import type { Permission } from '@/lib/supabase/types'

export const MFA_REQUIRED_PERMISSIONS: Permission[] = [
  'VIEW_ALL_PROJECTS',
  // Workspace-wide risk/exposure rollup (and its CSV/PDF export) — the same
  // sensitivity tier as VIEW_ALL_PROJECTS.
  'VIEW_PORTFOLIO',
  'VIEW_AUDIT_LOG',
  'MANAGE_BILLING',
  'MANAGE_ROLES',
  'MANAGE_WORKSPACE_SETTINGS',
  'DELETE_PROJECTS',
  // FIX (audit round 3): Phase 3 (approval chains) shipped APPROVE_DOCUMENTS
  // without adding it here, exactly the gap this file's own comment warned
  // about — approving/rejecting SOWs and COs (money authorization) never
  // triggered the MFA requirement.
  'APPROVE_DOCUMENTS',
  // FIX (section-by-section re-audit): the two permissions that actually
  // perform this product's core governance-bypass actions were missing.
  // GRANT_EXCEPTIONS writes a dollar-valued entry to exceptions_log and
  // resolves a Guardian scope-drift flag as bypassed (see
  // app/api/guardian/flags/[id]/route.ts's 'exception' action) — this is
  // the single most sensitive action in a scope-governance product.
  // APPROVE_FLAGS (resolve/close/escalate) is the same tier. Meanwhile
  // merely-read VIEW_ALL_PROJECTS was already forcing MFA. Same gap class
  // as the APPROVE_DOCUMENTS miss above, just never swept to these two.
  'GRANT_EXCEPTIONS',
  'APPROVE_FLAGS',
  // FIX (deep audit, RLS+permissions re-pass): VIEW_FINANCIALS and
  // VIEW_CLIENT_DATA read the same class of sensitive data
  // VIEW_ALL_PROJECTS was already flagged for (contract values, invoice
  // totals, payment milestones, client PII/contact/billing info — see
  // e.g. app/api/invoices/route.ts, app/api/clients/route.ts,
  // app/api/reports/*.ts) but sat outside this list despite being tiered
  // the same way. Confirmed both genuinely gate real reads across ~20
  // call sites each before adding — this file's own EXPORT_DATA removal
  // above is exactly the mistake to avoid making in reverse (listing a
  // permission that doesn't actually protect anything).
  'VIEW_FINANCIALS',
  'VIEW_CLIENT_DATA',
  // FIX (deep audit, RLS+permissions re-pass): the two are ordinary business
  // rather than governance-bypass actions — the tier at which this file
  // draws its line (VIEW_ALL_PROJECTS/VIEW_FINANCIALS/VIEW_CLIENT_DATA read;
  // MANAGE_*/DELETE_PROJECTS/APPROVE_*/GRANT_EXCEPTIONS act). Consciously
  // left out this round: INVITE_MEMBERS is close to that line (a compromised
  // account with it could invite an accomplice) and SEND_INVOICES touches
  // payment details, but neither reads or performs the governance-bypass/
  // sensitive-read actions above — flagged for a deliberate future call,
  // not silently missed.
  // FIX (deep audit, section 5 re-pass): the 'EXPORT_DATA' entry that used
  // to sit here has been removed, not just its comment. The permission it
  // pointed at never gated anything — see lib/supabase/types.ts for the
  // full story — and three separate places in this codebase's own history
  // (migration 006's note, app/api/reports/audit-export/route.ts's header
  // comment, and this file's own point 3 below) already documented the
  // deliberate decision that exporting reuses VIEW_AUDIT_LOG rather than
  // getting a permission of its own. VIEW_AUDIT_LOG being in this list
  // already covers the export path, since that's the only gate it's ever
  // had.
]

export function permissionsRequireMfa(permissions: Record<string, boolean> | Permission[] | null | undefined): boolean {
  if (!permissions) return false
  if (Array.isArray(permissions)) {
    return permissions.some(p => MFA_REQUIRED_PERMISSIONS.includes(p))
  }
  return MFA_REQUIRED_PERMISSIONS.some(p => permissions[p] === true)
}
