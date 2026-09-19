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

  // FIX (section-by-section re-audit) regression: GRANT_EXCEPTIONS and
  // APPROVE_FLAGS are the two permissions that actually perform this
  // product's governance-bypass actions (granting a scope exception,
  // resolving a Guardian flag) and must trigger MFA. Pin them so the gap
  // that let mere read access (VIEW_ALL_PROJECTS) require MFA while the
  // actual bypass actions didn't can't regress.
  it('GRANT_EXCEPTIONS and APPROVE_FLAGS are in the required list and trigger MFA', () => {
    expect(MFA_REQUIRED_PERMISSIONS).toContain('GRANT_EXCEPTIONS')
    expect(MFA_REQUIRED_PERMISSIONS).toContain('APPROVE_FLAGS')
    expect(permissionsRequireMfa(['GRANT_EXCEPTIONS'])).toBe(true)
    expect(permissionsRequireMfa(['APPROVE_FLAGS'])).toBe(true)
    expect(permissionsRequireMfa({ GRANT_EXCEPTIONS: true })).toBe(true)
    expect(permissionsRequireMfa({ APPROVE_FLAGS: true })).toBe(true)
  })

  // FIX (deep audit, RLS+permissions re-pass) regression: VIEW_FINANCIALS
  // and VIEW_CLIENT_DATA read the same sensitivity tier as VIEW_ALL_PROJECTS
  // (contract/invoice amounts, client PII) but sat outside this list. Pin
  // them the same way the entries above are pinned.
  it('VIEW_FINANCIALS and VIEW_CLIENT_DATA are in the required list and trigger MFA', () => {
    expect(MFA_REQUIRED_PERMISSIONS).toContain('VIEW_FINANCIALS')
    expect(MFA_REQUIRED_PERMISSIONS).toContain('VIEW_CLIENT_DATA')
    expect(permissionsRequireMfa(['VIEW_FINANCIALS'])).toBe(true)
    expect(permissionsRequireMfa(['VIEW_CLIENT_DATA'])).toBe(true)
    expect(permissionsRequireMfa({ VIEW_FINANCIALS: true })).toBe(true)
    expect(permissionsRequireMfa({ VIEW_CLIENT_DATA: true })).toBe(true)
  })
  // Portfolio deep audit: VIEW_PORTFOLIO (the dedicated Portfolio permission)
  // exposes the workspace-wide exposure rollup and its export.
  it('VIEW_PORTFOLIO is in the required list and triggers MFA', () => {
    expect(MFA_REQUIRED_PERMISSIONS).toContain('VIEW_PORTFOLIO')
    expect(permissionsRequireMfa(['VIEW_PORTFOLIO'])).toBe(true)
    expect(permissionsRequireMfa({ VIEW_PORTFOLIO: true })).toBe(true)
  })
})
