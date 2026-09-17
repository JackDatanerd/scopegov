// lib/utils/project-messages.ts
//
// Mentions are stored inline in the message body as tokens of the form
// @[Display Name](user-uuid) — the same "link-shaped" convention used by
// e.g. Slack's mrkdwn, so the mention survives edits/copy-paste without a
// separate ordered list to keep in sync with the text. The API extracts
// mentioned user ids from the body itself rather than trusting a
// separately-posted id list, so a mention notification can never fire for
// someone whose name doesn't actually appear in the message.

const MENTION_TOKEN = /@\[([^\]]+)\]\(([0-9a-f-]{36})\)/gi

// Shared message-length ceiling — used by both the create and edit routes.
export const MESSAGE_MAX_LENGTH = 4000


export interface ParsedMention {
  userId: string
  displayName: string
}

// Extracts every well-formed mention token from a message body.
// De-duplicated by user id — mentioning the same person twice in one
// message notifies them once, not twice.
export function extractMentions(body: string): ParsedMention[] {
  const seen = new Map<string, ParsedMention>()
  for (const match of Array.from(body.matchAll(MENTION_TOKEN))) {
    const [, displayName, userId] = match
    if (!seen.has(userId)) seen.set(userId, { userId, displayName })
  }
  return Array.from(seen.values())
}

// Renders stored @[Name](id) tokens down to plain "@Name" text — used
// wherever a message body needs to be plain text rather than the raw
// storage format (email/notification bodies, audit log entity names).
export function mentionsToPlainText(body: string): string {
  return body.replace(MENTION_TOKEN, (_m, name) => `@${name}`)
}

export type BodySegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; userId: string; name: string }

// Splits a message body into plain-text and mention segments, in order —
// what ProjectDiscussion.tsx renders each message with, so a mention can
// be styled as a chip instead of showing the raw @[Name](id) token.
export function splitBodySegments(body: string): BodySegment[] {
  const segments: BodySegment[] = []
  let lastIndex = 0
  for (const match of Array.from(body.matchAll(MENTION_TOKEN))) {
    const [full, name, userId] = match
    const index = match.index ?? 0
    if (index > lastIndex) segments.push({ type: 'text', value: body.slice(lastIndex, index) })
    segments.push({ type: 'mention', userId, name })
    lastIndex = index + full.length
  }
  if (lastIndex < body.length) segments.push({ type: 'text', value: body.slice(lastIndex) })
  return segments
}

// Shared by both the create (POST) and edit (PATCH) message routes —
// mentioning someone outside the project shouldn't silently notify a
// stranger, and shouldn't error the whole request either (the token was
// probably stale — e.g. the person was removed from the project between
// typing and sending/editing).
export async function filterMentionsToProjectMembers(
  service: any,
  workspaceId: string,
  projectId: string,
  mentions: ParsedMention[]
): Promise<ParsedMention[]> {
  const { data: members } = await service
    .from('project_members')
    .select('workspace_members!inner(user_id)')
    .eq('project_id', projectId)
    .eq('workspace_members.workspace_id', workspaceId)

  const memberIds = new Set(
    (members || []).map((m: any) => m.workspace_members?.user_id).filter(Boolean)
  )
  return mentions.filter(m => memberIds.has(m.userId))
}

// FIX (deep audit, section 7): previously only ever called from the POST
// (create) route. The PATCH (edit) route computed which mentions were
// newly added on an edit but never notified them — despite its own
// comment claiming "a mention added on edit still notifies (the person
// genuinely wasn't told before)". Extracted here so both routes share one
// implementation and can't drift out of sync again.
export async function notifyMentionedUsers(
  service: any,
  session: { id: string; workspaceId: string; name: string },
  projectId: string,
  projectName: string,
  rawBody: string,
  mentions: ParsedMention[]
) {
  const recipients = mentions.filter(m => m.userId !== session.id)
  if (!recipients.length) return

  try {
    const { data: prefs } = await service
      .from('notification_preferences')
      .select('user_id, in_app_enabled')
      .eq('workspace_id', session.workspaceId)
      .eq('event_type', 'project_message_mention')
      .in('user_id', recipients.map(r => r.userId))

    const suppressed = new Set(
      (prefs || []).filter((p: any) => p.in_app_enabled === false).map((p: any) => p.user_id)
    )

    const plain = mentionsToPlainText(rawBody)
    const snippet = plain.length > 120 ? `${plain.slice(0, 117)}…` : plain

    // entity_id points at the project (not the message) — NotificationBell
    // only has entity_type/entity_id to build a link from (no metadata
    // column on notifications), and "open the project's Discussion tab"
    // is a perfectly good destination for a mention notification.
    const rows = recipients
      .filter(r => !suppressed.has(r.userId))
      .map(r => ({
        workspace_id: session.workspaceId,
        recipient_id: r.userId,
        type: 'project_message_mention',
        title: `${session.name} mentioned you in ${projectName}`,
        body: snippet,
        entity_type: 'project_message',
        entity_id: projectId,
      }))

    if (rows.length) await service.from('notifications').insert(rows)
  } catch {
    // Never let a notification failure break message creation/editing.
  }
}
