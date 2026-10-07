// lib/utils/ops-recipients.ts
//
// OPS_ALERT_EMAIL may hold one address or several, separated by commas, semicolons or whitespace.
// sendEmail() treats a *string* `to` as exactly one address, so a list like "a@x.com,b@x.com" used to be
// rejected as "Invalid recipient address" and every ops page (billing incidents, cron failures, Guardian
// health) silently never left — logged to the console only. Always hand sendEmail the parsed array.

export function opsAlertRecipients(raw: string | undefined = process.env.OPS_ALERT_EMAIL): string[] {
  return Array.from(new Set(
    String(raw || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean),
  ))
}
