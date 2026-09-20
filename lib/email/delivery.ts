// lib/email/delivery.ts
//
// The Resend SDK reports API-level failures (unverified domain, quota / 429,
// invalid recipient …) by RESOLVING with `{ data: null, error }` — it does not
// throw. Every `try { await sendXEmail(...) } catch { log }` in the app therefore
// treated a rejected send as a success: the agency was told "sent", the client
// received nothing, and reminders burned their cooldown for an email that never
// left. checkedSend() turns both failure shapes (thrown or returned) into one
// explicit result the caller can act on and surface.

export type EmailDelivery = { ok: true } | { ok: false; error: string }

export function emailDeliveryError(result: unknown): string | null {
  const err = (result as any)?.error
  if (!err) return null
  if (typeof err === 'string') return err
  return err.message || err.name || 'The email provider rejected this message'
}

export async function checkedSend(send: () => Promise<unknown>, label = 'email'): Promise<EmailDelivery> {
  try {
    const result = await send()
    const error = emailDeliveryError(result)
    if (error) {
      console.error(`[email] ${label} was rejected by the provider:`, error)
      return { ok: false, error }
    }
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error(`[email] ${label} failed:`, message)
    return { ok: false, error: message }
  }
}
