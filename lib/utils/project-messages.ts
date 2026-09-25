// lib/utils/project-messages.ts
import { notifyUsers } from './notify'

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
    const [, displayName, rawId] = match
    const userId = rawId.toLowerCase() // uuids are stored lowercase; an upper-case token would dedupe wrongly
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

export interface Mentionable { id: string; name: string; email: string; avatarUrl: string | null }

// Who can be @-mentioned on a project: everyone who can actually SEE it — the assigned team (active
// members only) PLUS everyone with VIEW_ALL_PROJECTS (owners/admins see every project without being on its
// team). The picker used to offer only the assigned team, so an admin who follows a project without being
// assigned to it could never be pulled into its discussion; the server-side check was the same list.
export async function listMentionable(service: any, workspaceId: string, projectId: string): Promise<Mentionable[]> {
  const [{ data: team }, { data: members }] = await Promise.all([
    service.from('project_members_active').select('member_user_id')
      .eq('project_id', projectId).eq('project_workspace_id', workspaceId),
    service.from('workspace_members')
      .select('user_id, effective_permissions, users!workspace_members_user_id_fkey(id, name, email, avatar_url)')
      .eq('workspace_id', workspaceId).eq('status', 'active'),
  ])
  const onTeam = new Set((team || []).map((r: any) => r.member_user_id))
  return (members || [])
    .filter((m: any) => m.users && (onTeam.has(m.user_id) || m.effective_permissions?.VIEW_ALL_PROJECTS === true))
    .map((m: any) => ({ id: m.users.id as string, name: m.users.name as string, email: m.users.email as string, avatarUrl: m.users.avatar_url || null }))
}

// A display name is typed inside the token's brackets, so it can never contain one.
const tokenName = (name: string) => name.replace(/[\[\]()]/g, '').trim() || 'User'

// Shared by both the create (POST) and edit (PATCH) message routes.
//
// Returns the mentions that are valid (the person can see this project) with their REAL names, and the
// body rewritten to match: a token for a valid user carries that user's actual name (the token used to be
// trusted as typed, so `@[Alice](<bob's id>)` rendered "@Alice" while notifying Bob), and a token for
// someone who can't see the project degrades to plain "@Name" text — a stale token shouldn't notify a
// stranger, and shouldn't error the whole request either.
export async function resolveMentions(
  service: any, workspaceId: string, projectId: string, body: string,
): Promise<{ mentions: ParsedMention[]; body: string }> {
  const parsed = extractMentions(body)
  if (parsed.length === 0) return { mentions: [], body }
  const byId = new Map((await listMentionable(service, workspaceId, projectId)).map(m => [m.id.toLowerCase(), m]))
  const mentions: ParsedMention[] = []
  for (const m of parsed) {
    const u = byId.get(m.userId)
    if (u) mentions.push({ userId: m.userId, displayName: tokenName(u.name) })
  }
  const canonical = body.replace(MENTION_TOKEN, (_full, name: string, id: string) => {
    const u = byId.get(id.toLowerCase())
    return u ? `@[${tokenName(u.name)}](${u.id.toLowerCase()})` : `@${name}`
  })
  return { mentions, body: canonical }
}

// ── Composer round-trip ──────────────────────────────────────────────────────────────────────────
// The composer shows "@Alice Smith" (not the raw @[Alice Smith](uuid) token) and remembers who each
// picked name refers to. On send, picked names are turned back into tokens; on edit, tokens are turned
// into names and the map is rebuilt from the body.

export function tokensToDisplay(body: string): { text: string; picked: Record<string, string> } {
  const picked: Record<string, string> = {}
  const text = body.replace(MENTION_TOKEN, (_m, name: string, id: string) => {
    picked[name] = id.toLowerCase()
    return `@${name}`
  })
  return { text, picked }
}

export function displayToTokens(text: string, picked: Record<string, string>): string {
  let out = text
  // Longest names first so "@Alice Smith" wins over "@Alice".
  for (const name of Object.keys(picked).sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // NB: a plain string with an escaped backslash — inside a template literal `\p` would be swallowed.
    out = out.replace(new RegExp('@' + escaped + '(?![\\p{L}\\p{N}_])', 'gu'), () => `@[${name}](${picked[name]})`)
  }
  return out
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
  const candidates = mentions.filter(m => m.userId !== session.id)
  if (!candidates.length) return

  // FIX (Notifications & email fix round): mentions were inserted by hand with no check that
  // the person is still an ACTIVE member (a deactivated user who was still in project_members
  // was notified), and someone mentioned twice got two rows. notifyUsers dedupes, requires
  // active membership + project access, applies the in-app preference / workspace default
  // (the choke point the older comments here describe), and reads the insert's error.
  // entity_id stays the project: the bell builds its link from entity_type/entity_id only, and
  // "open the project's Discussion tab" is the right destination for a mention.
  try {
    const plain = mentionsToPlainText(rawBody)
    const snippet = plain.length > 120 ? `${plain.slice(0, 117)}…` : plain
    await notifyUsers(service, {
      workspaceId: session.workspaceId, recipientIds: candidates.map(m => m.userId),
      type: 'project_message_mention', eventType: 'project_message_mention',
      title: `${session.name} mentioned you in ${projectName}`, body: snippet,
      entityType: 'project_message', entityId: projectId, projectId,
      excludeUserId: session.id,
    })
  } catch (err) {
    console.error('notifyMentionedUsers failed:', err)
  }
}
