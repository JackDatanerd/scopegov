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
