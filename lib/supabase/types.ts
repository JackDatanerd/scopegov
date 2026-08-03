// lib/supabase/types.ts
// Hand-authored types matching spec v11 exactly.
// BUG-039: ALL .from() calls use (supabase as any) — these types are for
// manual reference only, not for generic inference.

export type Plan = 'trial' | 'solo' | 'starter' | 'pro' | 'agency'

export type ProjectType =
  | 'web'
  | 'mobile'
  | 'brand'
  | 'ecomm'
  | 'marketing'
  | 'retainer'
  | 'video'
  | 'other'

export type ProjectStatus =
  | 'Draft'
  | 'Intake'
  | 'Awaiting Signature'
  | 'Changes Requested'
  | 'Active'
  | 'Stalled'
  | 'Complete'
  | 'Archived'

export type SowStatus =
  | 'draft'
  | 'awaiting_signature'
  | 'signed'
  | 'declined'
  | 'changes_requested'
  | 'withdrawn'
  | 'expired'

export type CoStatus =
  | 'draft'
  | 'awaiting_response'
  | 'accepted'
  | 'declined'
  | 'countered'
  | 'closed'
  | 'stalled'
  | 'withdrawn'
  | 'exception_granted'

export type FlagStatus = 'open' | 'resolved' | 'closed' | 'converted_to_co'
export type GuardianOutcome = 'pending' | 'in_scope' | 'borderline' | 'out_of_scope' | 'covered_by_co'
export type GuardianSensitivity = 'conservative' | 'medium' | 'aggressive'
export type MemberStatus = 'active' | 'invited' | 'deactivated'
export type MilestoneStatus = 'pending' | 'invoiced' | 'paid' | 'overdue'
export type InvoiceStatus = 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'void'
export type InvoicePaymentMethod = 'bank_transfer' | 'stripe' | 'check' | 'cash' | 'other'

// ── WORKSPACES ────────────────────────────────────────────────

export interface Workspace {
  id: string
  name: string
  slug: string
  slugChangedAt: string | null
  // jwtSecret intentionally omitted — never in API responses (BUG-062)
  agencyName: string
  brandColour: string
  logoStoragePath: string | null
  industry: string
  currency: string
  timezone: string
  sowLanguage: string
  governingLaw: string
  proactiveRiskThreshold: number
  proactiveRiskAlertsEnabled: boolean
  planTier: Plan
  trialEndsAt: string | null
  onboardingCompletedAt: string | null
  firstSowSignedAt: string | null
  deletedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface WorkspaceWithSecret extends Workspace {
  jwtSecret: string // server-side only
}

// ── USERS ─────────────────────────────────────────────────────

export interface User {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  activeWorkspaceId: string | null
  emailVerifiedAt: string | null
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

// ── WORKSPACE MEMBERS ─────────────────────────────────────────

export interface WorkspaceMember {
  id: string
  workspaceId: string
  userId: string
  roleId: string | null
  permissionOverrides: Record<string, boolean> | null
  effectivePermissions: Record<string, boolean>
  status: MemberStatus
  inviteToken: string | null
  inviteTokenExpiresAt: string | null
  invitedAt: string | null
  joinedAt: string | null
  deactivatedAt: string | null
  invitedBy: string | null
  createdAt: string
  // joined from users
  user?: { id: string; name: string; email: string; avatarUrl: string | null }
  role?: { id: string; name: string }
}

// ── ROLES ─────────────────────────────────────────────────────

export type Permission =
  | 'VIEW_OWN_PROJECTS'
  | 'VIEW_ALL_PROJECTS'
  | 'VIEW_FINANCIALS'
  | 'VIEW_CLIENT_DATA'
  | 'CREATE_PROJECTS'
  | 'EDIT_SOW'
  | 'SEND_SOW'
  | 'CREATE_CHANGE_ORDERS'
  | 'SEND_CHANGE_ORDERS'
  | 'APPROVE_FLAGS'
  | 'GRANT_EXCEPTIONS'
  | 'MARK_DELIVERABLE_STATUS'
  | 'MARK_PAYMENT_MILESTONES'
  | 'MARK_PROJECT_COMPLETE'
  | 'ASSIGN_TEAM_MEMBERS'
  | 'SUBMIT_GUARDIAN_CHECKS'
  | 'ACCESS_GUARDIAN_HISTORY'
  | 'INVITE_MEMBERS'
  | 'MANAGE_ROLES'
  | 'MANAGE_BILLING'
  | 'EXPORT_DATA'
  | 'DELETE_PROJECTS'
  | 'VIEW_AUDIT_LOG'
  | 'MANAGE_WORKSPACE_SETTINGS'
  | 'SEND_INVOICES'
  // Phase 3 — Approval Chains. Deliberately a single permission rather than
  // split per document type: the workflow config (approval_workflows /
  // approval_workflow_steps) already scopes *which* documents a given role
  // or user approves, so splitting the permission itself would just add
  // bureaucracy without adding real granularity.
  | 'APPROVE_DOCUMENTS'

export const ALL_PERMISSIONS: Permission[] = [
  'VIEW_OWN_PROJECTS', 'VIEW_ALL_PROJECTS', 'VIEW_FINANCIALS', 'VIEW_CLIENT_DATA',
  'CREATE_PROJECTS', 'EDIT_SOW', 'SEND_SOW', 'CREATE_CHANGE_ORDERS', 'SEND_CHANGE_ORDERS',
  'APPROVE_FLAGS', 'GRANT_EXCEPTIONS', 'MARK_DELIVERABLE_STATUS', 'MARK_PAYMENT_MILESTONES',
  'MARK_PROJECT_COMPLETE', 'ASSIGN_TEAM_MEMBERS', 'SUBMIT_GUARDIAN_CHECKS',
  'ACCESS_GUARDIAN_HISTORY', 'INVITE_MEMBERS', 'MANAGE_ROLES', 'MANAGE_BILLING',
  'EXPORT_DATA', 'DELETE_PROJECTS', 'VIEW_AUDIT_LOG', 'MANAGE_WORKSPACE_SETTINGS',
  'SEND_INVOICES', 'APPROVE_DOCUMENTS',
]

export interface Role {
  id: string
  workspaceId: string
  name: string
  description: string | null
  permissions: Record<Permission, boolean>
  isDefault: boolean
  createdBy: string
  createdAt: string
  updatedAt: string
}

// ── CLIENTS ───────────────────────────────────────────────────

export interface Client {
  id: string
  workspaceId: string
  name: string
  companyName: string | null
  email: string
  ccEmails: string[]
  phone: string | null
  timezone: string | null
  billingAddress: Record<string, string> | null
  vatNumber: string | null
  paymentTermsNote: string | null
  notes: string | null
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

// ── PROJECTS ──────────────────────────────────────────────────

export interface Project {
  id: string
  workspaceId: string
  clientId: string
  name: string
  disc: string | null
  type: ProjectType
  status: ProjectStatus
  stallReason: 'sow_unsigned' | 'manual' | null
  contractValue: number
  currency: string
  startDate: string | null
  internalRef: string | null
  retainerDurationMonths: number | null
  onboardingSource: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  // computed / joined
  client?: Client
  effectiveContractValue?: number
  guardianEmail?: string | null
}

// ── SOW DOCUMENTS ─────────────────────────────────────────────

export interface SowSection {
  id: string
  title: string
  content: string // TipTap HTML
  visible: boolean
  order: number
}

export interface SowMetadata {
  paymentStructure?: string
  paymentSplit?: string
  governingLaw?: string
  revisionRounds?: number
  revisionPolicy?: string
  paymentDueDays?: number
  lateFeeRate?: number
  extraRevisionRate?: number
}

export interface SowDocument {
  id: string
  projectId: string
  workspaceId: string
  version: number
  status: SowStatus
  sentAt: string | null
  signedAt: string | null
  signedBy: string | null
  signerEmail: string | null
  signerIp: string | null
  declinedAt: string | null
  declinedReason: string | null
  expiresAt: string | null
  token: string | null
  previousVersionId: string | null
  sections: SowSection[]
  metadata: SowMetadata
  createdAt: string
  updatedAt: string
}

// ── PAYMENT MILESTONES ────────────────────────────────────────

export interface PaymentMilestone {
  id: string
  projectId: string
  sowId: string
  title: string
  type: 'fixed' | 'percentage' | 'hourly_cap' | 'retainer_monthly'
  amount: number
  percentage: number | null
  trigger: string
  taxRate: number
  taxInclusive: boolean
  dueDate: string | null
  status: MilestoneStatus
  invoicedAt: string | null
  paidAt: string | null
  notes: string | null
  createdAt: string
}

// ── INVOICES (Phase 4a) ──────────────────────────────────────
// Client invoicing: distinct from `billing` (agency's own ScopeGov
// subscription). ScopeGov generates + sends the document and tracks
// status; it never processes the payment — every InvoicePayment row
// is a manual entry an agency user logs after receiving money outside
// the app (wire, Stripe invoice they sent separately, check, cash).

export interface Invoice {
  id: string
  workspaceId: string
  projectId: string
  milestoneId: string | null
  sowId: string | null
  coId: string | null
  invoiceNumber: string | null
  title: string
  amount: number
  amountPaid: number
  currency: string
  status: InvoiceStatus
  dueDate: string | null
  paymentInstructions: string | null
  notes: string | null
  token: string | null
  expiresAt: string | null
  sentAt: string | null
  paidAt: string | null
  voidedAt: string | null
  voidReason: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface InvoicePayment {
  id: string
  invoiceId: string
  amount: number
  paidAt: string
  method: InvoicePaymentMethod
  referenceNote: string | null
  recordedBy: string
  createdAt: string
}

// ── CHANGE ORDERS ─────────────────────────────────────────────

export interface CoLineItem {
  id: string
  description: string
  quantity: number
  rate: number
  total: number
}

export interface ChangeOrder {
  id: string
  projectId: string
  workspaceId: string
  flagId: string | null
  parentCoId: string | null
  version: number
  title: string
  note: string | null
  status: CoStatus
  lineItems: CoLineItem[]
  subtotal: number
  taxRate: number
  taxInclusive: boolean
  total: number
  sentAt: string | null
  respondedAt: string | null
  acceptedAt: string | null
  acceptedBy: string | null
  counterAmount: number | null
  counterNote: string | null
  counterAcceptedAt: string | null
  counterAcceptedBy: string | null
  declinedAt: string | null
  declinedReason: string | null
  closeReason: string | null
  exceptionReason: string | null
  exceptionValue: number | null
  escalatedTo: string | null
  escalationNote: string | null
  token: string | null
  expiresAt: string | null
  isRetainerRenewal: boolean
  assignedTo: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface Amendment {
  id: string
  projectId: string
  workspaceId: string
  changeOrderId: string
  signedSowId: string
  title: string
  addedDeliverables: string[]
  removedDeliverables: string[]
  financialImpact: number
  effectiveAt: string
  pdfPath: string
  createdAt: string
}

// ── GUARDIAN ──────────────────────────────────────────────────

export interface GuardianCheck {
  id: string
  projectId: string
  workspaceId: string
  content: string
  source: 'email' | 'paste' | 'slack' | 'webhook'
  sourceMetadata: Record<string, unknown> | null
  submittedBy: string | null
  submittedAt: string
  isRetroactive: boolean
  isDuplicate: boolean
  duplicateOfId: string | null
  matchConfidence: number | null
  creepConfidence: number | null
  matchedAgainst: 'sow' | 'amendment' | null
  matchedReference: string | null
  matchedAmendmentId: string | null
  outcome: GuardianOutcome
  classifiedAt: string | null
  classificationFailed: boolean
  flagId: string | null
  createdAt: string
}

export interface GuardianFlag {
  id: string
  projectId: string
  workspaceId: string
  checkId: string
  changeOrderId: string | null
  type: string
  severity: 'high' | 'medium' | 'low'
  description: string
  sowReference: string
  status: FlagStatus
  resolution: 'change_order' | 'exception' | 'closed' | null
  resolvedBy: string | null
  resolvedAt: string | null
  closeReason: string | null
  escalatedTo: string | null
  escalationNote: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectScopeSnapshot {
  id: string
  projectId: string
  deliverables: Array<{ title: string; description: string }>
  outOfScope: Array<{ title: string; description: string }>
  lastUpdatedAt: string
  lastUpdatedBy: 'signing' | 'amendment' | 'scope_adjustment'
}

// ── NOTIFICATIONS ─────────────────────────────────────────────

export interface Notification {
  id: string
  workspaceId: string
  recipientId: string
  type: string
  title: string
  body: string
  entityType: string | null
  entityId: string | null
  read: boolean
  readAt: string | null
  createdAt: string
}

// ── AUDIT LOG ─────────────────────────────────────────────────

export interface AuditEntry {
  id: string
  workspaceId: string
  actorId: string | null
  actorEmail: string
  actorName: string
  eventType: string
  entityType: string
  entityId: string | null
  entityName: string | null
  metadata: Record<string, unknown>
  ipAddress: string | null
  createdAt: string
}

// ── SESSION / JWT ─────────────────────────────────────────────

export interface SessionUser {
  id: string
  name: string
  email: string
  avatarUrl: string | null
  workspaceId: string
  workspaceName: string
  agencyName: string
  planTier: Plan
  trialEndsAt: string | null
  onboardingCompletedAt: string | null
  permissions: Permission[]
  emailVerifiedAt: string | null
  logoStoragePath: string | null
  brandColour: string | null
}
