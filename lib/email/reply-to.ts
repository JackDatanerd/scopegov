// lib/email/reply-to.ts
//
// FEATURE (Notifications & email fix round): every client-facing email was
// sent from noreply@… with no Reply-To, while the body said "please contact
// the agency directly" without saying how. A client who simply hit Reply
// (the most natural reaction to an invoice or SOW) wrote into a void.
//
// Resolution order:
//   1. the workspace's own `reply_to_email` (a shared inbox such as
//      billing@agency.com) — set in Settings → Workspace,
//   2. the person who triggered the send (they are the human the client is
//      dealing with, and it is already in the audit trail).
//   3. the workspace's owner (its creator, while still an active member). Emails triggered by the
//      CLIENT (portal confirmations) or by a cron (reminders) have no acting agency user, so with no
//      workspace reply-to configured they used to go out with no Reply-To at all and a client's reply
//      vanished. A human at the agency now always receives it.
// Returns null when none exists; sendEmail() then omits the header.

import { isDeliverableAddress } from '@/lib/email/send'

export async function resolveReplyTo(
  service: any,
  workspaceId: string,
  actorEmail?: string | null,
): Promise<string | null> {
  try {
    const { data, error } = await service
      .from('workspaces').select('reply_to_email').eq('id', workspaceId).maybeSingle()
    // `error` is expected (and ignored) before the column's migration is applied.
    if (!error && isDeliverableAddress(data?.reply_to_email)) return String(data.reply_to_email).trim()
  } catch { /* fall through to the actor */ }
  if (isDeliverableAddress(actorEmail)) return actorEmail!.trim()
  return resolveOwnerEmail(service, workspaceId)
}

async function resolveOwnerEmail(service: any, workspaceId: string): Promise<string | null> {
  try {
    const { data: ws } = await service.from('workspaces').select('created_by').eq('id', workspaceId).maybeSingle()
    if (!ws?.created_by) return null
    const { data: member } = await service
      .from('workspace_members')
      .select('users!workspace_members_user_id_fkey(email)')
      .eq('workspace_id', workspaceId).eq('user_id', ws.created_by).eq('status', 'active')
      .maybeSingle()
    const email = member?.users?.email
    return isDeliverableAddress(email) ? String(email).trim() : null
  } catch { return null }
}
