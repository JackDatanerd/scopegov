// lib/auth/mfa-policy.ts
//
// Single source of truth for "which permissions make MFA mandatory."
// Deliberately a fixed constant, not a workspace-configurable setting —
// see the note at the bottom of supabase/migrations/003_mfa_backup_codes.sql
// for why. If Phase 3 (approval chains) ships APPROVE_DOCUMENTS, add it
// here and enforcement picks it up everywhere automatically — middleware,
// the settings compliance panel, and the team roster badge all read from
// this one list.

import type { Permission } from '@/lib/supabase/types'

export const MFA_REQUIRED_PERMISSIONS: Permission[] = [
  'VIEW_ALL_PROJECTS',
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
]

export function permissionsRequireMfa(permissions: Record<string, boolean> | Permission[] | null | undefined): boolean {
  if (!permissions) return false
  if (Array.isArray(permissions)) {
    return permissions.some(p => MFA_REQUIRED_PERMISSIONS.includes(p))
  }
  return MFA_REQUIRED_PERMISSIONS.some(p => permissions[p] === true)
}
