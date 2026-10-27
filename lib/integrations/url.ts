// lib/integrations/url.ts
//
// Syntactic checks on a webhook target at save time, so an obviously bad URL is refused with a clear message
// instead of failing silently for days. This is NOT the SSRF defence: delivery goes through safeFetch(), which
// resolves DNS and refuses private/reserved/link-local targets on every redirect hop.

import net from 'node:net'

export function validateWebhookUrl(raw: unknown, env: NodeJS.ProcessEnv = process.env): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a webhook URL.' }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'Enter a webhook URL.' }
  if (trimmed.length > 2048) return { ok: false, error: 'That URL is too long.' }
  let u: URL
  try { u = new URL(trimmed) } catch { return { ok: false, error: 'That is not a valid URL.' } }
  const allowHttp = env.NODE_ENV !== 'production'
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return { ok: false, error: 'The URL must start with https://.' }
  if (u.username || u.password) return { ok: false, error: 'Put credentials in a header on the receiving side, not in the URL.' }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (!host.includes('.') && !net.isIP(host)))
    return { ok: false, error: 'That address is not reachable from the internet.' }
  if (net.isIP(host)) return { ok: false, error: 'Use a hostname, not an IP address.' }
  return { ok: true, url: u.toString() }
}
