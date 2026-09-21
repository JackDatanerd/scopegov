// lib/documents/preflight.ts
//
// Send preconditions that used to be checked only AFTER the approval gate — so
// an approver could spend a day signing off on a send that could never happen
// ("Client email is required"), and the requester only found out when the
// auto-send failed. Checked before evaluateApprovalGate() in every send route.

/** A human-readable reason a document for this project can't reach its client, or null. */
export async function sendBlockedReason(service: any, projectId: string): Promise<string | null> {
  const { data } = await service
    .from('projects')
    .select('deleted_at, clients(email)')
    .eq('id', projectId)
    .maybeSingle()
  if (!data) return null // the send path reports a missing project itself
  if (data.deleted_at) return 'This project has been deleted, so nothing can be sent for it.'
  if (!data.clients?.email)
    return "This project's client has no email address — add one before sending so the document can actually reach them."
  return null
}

/** true when a YYYY-MM-DD due date is clearly in the past (one day of slack for time zones). */
export function isDueDateInPast(dueDate: string | null | undefined, now: Date = new Date()): boolean {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}/.test(dueDate)) return false
  const cutoff = new Date(now.getTime() - 86400000).toISOString().slice(0, 10)
  return dueDate.slice(0, 10) < cutoff
}
