import { describe, it, expect } from 'vitest'
import { notificationHref, timeAgo } from '@/lib/utils/notification-links'

const n = (type: string, entity_type: string | null, entity_id: string | null, project_id: string | null = null) =>
  ({ type, entity_type, entity_id, project_id })

describe('notificationHref', () => {
  it('sends billing, guardian, CO and SOW events to their own project tab', () => {
    expect(notificationHref(n('invoice_overdue', 'project', 'p'))).toBe('/projects/p?tab=billing')
    expect(notificationHref(n('retainer_ending', 'project', 'p'))).toBe('/projects/p?tab=billing')
    expect(notificationHref(n('guardian_flag', 'project', 'p'))).toBe('/projects/p?tab=guardian')
    expect(notificationHref(n('escalation_flag', 'project', 'p'))).toBe('/projects/p?tab=guardian')
    expect(notificationHref(n('co_accepted', 'project', 'p'))).toBe('/projects/p?tab=co')
    expect(notificationHref(n('escalation_co', 'project', 'p'))).toBe('/projects/p?tab=co')
    expect(notificationHref(n('sow_signed', 'project', 'p'))).toBe('/projects/p?tab=sow')
  })
  it('routes the new "client opened" events to the document tab', () => {
    expect(notificationHref(n('sow_viewed', 'project', 'p'))).toBe('/projects/p?tab=sow')
    expect(notificationHref(n('co_viewed', 'project', 'p'))).toBe('/projects/p?tab=co')
    expect(notificationHref(n('invoice_viewed', 'project', 'p'))).toBe('/projects/p?tab=billing')
  })
  it('falls back to the project overview (project_assigned) and to nowhere for a removal', () => {
    expect(notificationHref(n('project_assigned', 'project', 'p'))).toBe('/projects/p')
    expect(notificationHref(n('project_removed', null, null))).toBeNull()
  })
  it('links discussion mentions, approvals, comments and team events', () => {
    expect(notificationHref(n('project_message_mention', 'project_message', 'p'))).toBe('/projects/p?tab=discussion')
    expect(notificationHref(n('approval_requested', 'approval_request', 'r'))).toBe('/approvals?highlight=r')
    expect(notificationHref(n('flag_comment_added', 'flag', 'f', 'p'))).toBe('/projects/p?tab=guardian')
    expect(notificationHref(n('member_joined', 'team', null))).toBe('/team')
    expect(notificationHref(n('member_role_changed', 'team', null))).toBe('/team')
  })
  it('has no link for security notices', () => {
    expect(notificationHref(n('security', null, null))).toBeNull()
  })
})

describe('timeAgo', () => {
  const now = Date.parse('2026-09-20T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()
  it('reads naturally up to a week', () => {
    expect(timeAgo(ago(10_000), now)).toBe('just now')
    expect(timeAgo(ago(5 * 60_000), now)).toBe('5m ago')
    expect(timeAgo(ago(3 * 3600_000), now)).toBe('3h ago')
    expect(timeAgo(ago(2 * 86400_000), now)).toBe('2d ago')
  })
  it('switches to a date after a week instead of "23d ago"', () => {
    expect(timeAgo(ago(23 * 86400_000), now)).toMatch(/Aug/)
  })
})

describe('notificationHref — trial countdown', () => {
  it('sends a trial_ending notification to billing settings', () => {
    expect(notificationHref(n('trial_ending', 'workspace', 'w1'))).toBe('/settings?tab=billing')
  })
})
