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
  // Added in cron/portal audit round 3: a client says they have paid, from the invoice portal.
  'invoice_payment_claimed',
] as const

export const IN_APP_ONLY_EVENT_TYPES = [
  'approval_no_reachable_approver', 'flag_comment_added', 'project_message_mention',
  // Added in the Notifications & email fix round:
  'member_joined', 'client_viewed',
  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — minor):
  // workspace/leave used to reuse 'member_joined' (labeled "Teammate
  // joined" in Settings, described only as "when someone you invited
  // accepts and joins") to also gate its "a teammate left" notification —
  // muting new-member notices silently muted leave notices too, with no
  // separate toggle and no UI copy admitting the overlap. Distinct key now.
  'member_left',
  // FIX (fix round, Projects & Dashboard section 7): the exact same overlap
  // bug as member_left above, just never caught here — DELETE
  // /api/projects/[id]/members reused 'project_assigned' (labeled "Added to
  // a project" in Settings) to gate the "removed from a project" bell
  // notification, so muting one silently muted the other with no separate
  // toggle and no UI copy admitting it. Distinct key, same in-app-only shape
  // (removal never had an email path).
  'project_removed',
] as const

export const ALL_EVENT_TYPES: readonly string[] = [...EMAIL_EVENT_TYPES, ...IN_APP_ONLY_EVENT_TYPES]

export function isInAppOnly(eventType: string): boolean {
  return (IN_APP_ONLY_EVENT_TYPES as readonly string[]).includes(eventType)
}
