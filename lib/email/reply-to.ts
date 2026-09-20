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
// Returns null when neither exists; sendEmail() then omits the header.

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
  return isDeliverableAddress(actorEmail) ? actorEmail!.trim() : null
}
