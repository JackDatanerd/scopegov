import { describe, it, expect } from 'vitest'
import { permissionsRequireMfa, MFA_REQUIRED_PERMISSIONS } from '@/lib/auth/mfa-policy'

describe('permissionsRequireMfa', () => {
  it('returns false for null/undefined', () => {
    expect(permissionsRequireMfa(null)).toBe(false)
    expect(permissionsRequireMfa(undefined)).toBe(false)
  })

  it('returns false for an array with no sensitive permissions', () => {
    expect(permissionsRequireMfa(['VIEW_OWN_PROJECTS', 'EDIT_SOW'])).toBe(false)
  })

  it('returns true for an array containing a sensitive permission', () => {
    expect(permissionsRequireMfa(['VIEW_OWN_PROJECTS', 'MANAGE_ROLES'])).toBe(true)
  })

  it('returns false for a permissions object with everything false', () => {
    expect(permissionsRequireMfa({ MANAGE_ROLES: false, DELETE_PROJECTS: false })).toBe(false)
  })

  it('returns true for a permissions object with a sensitive key set true', () => {
    expect(permissionsRequireMfa({ MANAGE_ROLES: false, DELETE_PROJECTS: true })).toBe(true)
  })

  // FIX (audit round 3) regression: APPROVE_DOCUMENTS (Phase 3 approval
  // chains) must trigger MFA — this was the exact gap that shipped
  // silently until a prior audit caught it. Pin it so it can't regress.
  it('APPROVE_DOCUMENTS is in the required list and triggers MFA', () => {
    expect(MFA_REQUIRED_PERMISSIONS).toContain('APPROVE_DOCUMENTS')
    expect(permissionsRequireMfa(['APPROVE_DOCUMENTS'])).toBe(true)
    expect(permissionsRequireMfa({ APPROVE_DOCUMENTS: true })).toBe(true)
  })
})
