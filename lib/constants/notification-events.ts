// lib/constants/notification-events.ts
//
// The single list of notification event types. It used to be maintained by hand in four places
// (the preferences route, the workspace-defaults route, and two item lists in SettingsClient),
// each with a comment warning that the others had to be kept in sync manually.
//
// EMAIL events can be sent by email AND appear in the bell; users choose each channel separately.
// IN_APP_ONLY events only ever appear in the bell.
//
// Deliberately NOT here: security and account-access notices (MFA changes, role changes,
// deactivation, ownership transfer) and email-bounce alerts. Those are mandatory — a user must
// not be able to mute being told their access changed.

export const EMAIL_EVENT_TYPES = [
  'sow_signed', 'sow_declined', 'sow_changes_requested', 'co_accepted', 'co_declined', 'co_countered',
  'guardian_flag', 'escalation', 'trial_ending',
  'invoice_payment_received', 'invoice_overdue', 'approval_requested',
  'co_stalled', 'sow_stalled',
  'sow_expired',
  'approval_decision',
  'invoice_sent',
  'co_expired',
  'payment_milestone_overdue', 'retainer_ending', 'guardian_flag_stalled', 'invoice_disputed',
  // Added in the Notifications & email fix round:
  'project_assigned',
] as const

export const IN_APP_ONLY_EVENT_TYPES = [
  'approval_no_reachable_approver', 'flag_comment_added', 'project_message_mention',
  // Added in the Notifications & email fix round:
  'member_joined', 'client_viewed',
] as const

export const ALL_EVENT_TYPES: readonly string[] = [...EMAIL_EVENT_TYPES, ...IN_APP_ONLY_EVENT_TYPES]

export function isInAppOnly(eventType: string): boolean {
  return (IN_APP_ONLY_EVENT_TYPES as readonly string[]).includes(eventType)
}
