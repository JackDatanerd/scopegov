// lib/email/delivery.ts
//
// The Resend SDK reports API-level failures (unverified domain, quota / 429,
// invalid recipient …) by RESOLVING with `{ data: null, error }` — it does not
// throw. Every `try { await sendXEmail(...) } catch { log }` in the app therefore
// treated a rejected send as a success: the agency was told "sent", the client
// received nothing, and reminders burned their cooldown for an email that never
// left. checkedSend() turns both failure shapes (thrown or returned) into one
// explicit result the caller can act on and surface.

// `skipped` is true when sendEmail had no deliverable recipient (empty list, or only anonymised accounts) and never
// called the provider. For an internal fan-out that is fine; for a message to ONE client it means nothing was sent.
export type EmailDelivery = { ok: true; skipped?: boolean } | { ok: false; error: string }

export interface CheckedSendOptions {
  /** Treat "nothing was sent because there was no deliverable recipient" as a failure. Use for client-facing sends. */
  requireRecipient?: boolean
}

export function emailDeliveryError(result: unknown): string | null {
  const err = (result as any)?.error
  if (!err) return null
  if (typeof err === 'string') return err
  return err.message || err.name || 'The email provider rejected this message'
}

export async function checkedSend(
  send: () => Promise<unknown>, label = 'email', opts: CheckedSendOptions = {},
): Promise<EmailDelivery> {
  try {
    const result = await send()
    const error = emailDeliveryError(result)
    if (error) {
      console.error(`[email] ${label} was rejected by the provider:`, error)
      return { ok: false, error }
    }
    // FIX (Notifications & email pass 18 — B2): a send skipped for lack of a deliverable recipient resolves as
    // `{ ok: true, skipped: true }` and was flattened to a plain success here, so a client-facing send that reached
    // nobody was reported as delivered. The flag now survives, and client-facing callers can refuse it.
    if ((result as any)?.skipped === true) {
      if (opts.requireRecipient) {
        const message = 'There is no deliverable email address for this recipient'
        console.error(`[email] ${label} was not sent:`, message)
        return { ok: false, error: message }
      }
      return { ok: true, skipped: true }
    }
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[email] ${label} failed:`, message)
    return { ok: false, error: message }
  }
}
