// lib/ai/guardian-email.ts
//
// Pure helpers for the Guardian inbound-email webhook (no aliased imports, so they
// are unit-testable in isolation — see tests/guardian-email.test.ts).
//
// FIX (independent pass, section 13): extractUnquotedContent used to be a per-line
// filter. It removed the "-----Original Message-----" marker line and "From:"/"Sent:"
// lines but left the ENTIRE quoted body of an Outlook-style reply in place (so an old,
// already-handled scope request was re-classified as new), never matched Gmail's
// attribution line when the mail client wrapped it over two lines ("On … <a@b.com>" /
// "wrote:"), and deleted any legitimate line that merely began with "From:" or "---".
// Replies are now CUT at the first reply marker instead of filtered line-by-line.
//
// The one wrinkle: the documented workflow is to FORWARD a client's email to the
// project's Guardian address, and a forward's quoted content IS the client request.
// A forward is recognised from the subject (Fwd:/FW:) or a forwarded-message banner, and
// in that case the forwarded body is kept (only its header block is dropped).

const FORWARD_SUBJECT = /^\s*(fwd?|fw|wg|tr|rv)\s*:/i
const FORWARD_BANNER  = /^[-–—_\s]*(begin forwarded message|forwarded message)[-–—_:\s]*$/i
const ORIGINAL_MSG    = /^[-–—_\s]*original message[-–—_\s]*$/i
const OUTLOOK_RULE    = /^_{20,}\s*$/
const HEADER_LINE     = /^(from|sent|date|to|cc|bcc|subject|reply-to)\s*:/i
const ON_WROTE_ONE    = /^on\s.{5,300}\swrote:\s*$/i
const ON_WROTE_START  = /^on\s.{5,300}$/i
const WROTE_ONLY      = /^wrote:\s*$/i
const SIGNATURE_DELIM = /^--\s?$/

export function isForwardSubject(subject: string): boolean {
  return FORWARD_SUBJECT.test(subject || '')
}

/** Strip a leading Re:/Fwd: chain from a subject for display/classification. */
export function cleanSubject(subject: string): string {
  return String(subject || '').replace(/^\s*((re|fwd?|fw|wg|tr|rv|aw)\s*:\s*)+/i, '').trim().slice(0, 300)
}

export function extractUnquotedContent(text: string, opts: { isForward?: boolean } = {}): string {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let forwarded = !!opts.isForward

  let i = 0
  for (; i < lines.length; i++) {
    const raw = lines[i]
    const t = raw.trim()

    if (SIGNATURE_DELIM.test(raw.trimEnd()) || t === '-- ') break
    if (t.startsWith('>')) continue

    // Gmail / Apple Mail attribution, possibly wrapped onto the next line.
    if (ON_WROTE_ONE.test(t)) break
    if (ON_WROTE_START.test(t) && !t.endsWith('wrote:') && WROTE_ONLY.test((lines[i + 1] || '').trim())) break
    if (ON_WROTE_START.test(t) && /wrote:\s*$/i.test((lines[i + 1] || '').trim()) && (lines[i + 1] || '').trim().length < 120) break

    if (FORWARD_BANNER.test(t)) { forwarded = true; skipHeaderBlock(); continue }

    const startsOutlook = ORIGINAL_MSG.test(t) || OUTLOOK_RULE.test(t) || isHeaderPair(lines, i)
    if (startsOutlook) {
      if (!forwarded) break            // reply: everything below is the quoted thread
      skipHeaderBlock(); continue       // forward: keep the forwarded body, drop its headers
    }

    out.push(raw)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()

  // Advance past the run of header lines (From:/Sent:/To:/Subject: …) + blank lines that follows.
  function skipHeaderBlock() {
    while (i + 1 < lines.length && (HEADER_LINE.test(lines[i + 1].trim()) || lines[i + 1].trim() === '')) i++
  }
}

// A "From: x" line immediately followed (within 3 lines) by "Sent:"/"Date:" is an
// Outlook-style quoted header block; a lone "From:" line in prose is not.
function isHeaderPair(lines: string[], i: number): boolean {
  if (!/^from\s*:/i.test(lines[i].trim())) return false
  for (let k = 1; k <= 3; k++) {
    if (/^(sent|date)\s*:/i.test((lines[i + k] || '').trim())) return true
  }
  return false
}

// ── Auto-responders / bounces ─────────────────────────────────
export function isAutomatedMessage(payload: any): boolean {
  const headers: Array<{ Name?: string; Value?: string }> = Array.isArray(payload?.Headers) ? payload.Headers : []
  const get = (n: string) => headers.find(h => (h.Name || '').toLowerCase() === n)?.Value?.trim().toLowerCase()
  const autoSubmitted = get('auto-submitted')
  if (autoSubmitted && autoSubmitted !== 'no') return true
  if (get('x-autoreply') || get('x-autorespond') || get('x-failed-recipients')) return true
  const precedence = get('precedence')
  if (precedence && ['bulk', 'junk', 'auto_reply', 'auto-reply', 'list'].includes(precedence)) return true
  const from = String(payload?.FromFull?.Email || payload?.From || '').toLowerCase()
  if (/(^|<)(mailer-daemon|postmaster)@/.test(from)) return true
  return false
}

export function senderEmail(payload: any): string {
  const full = payload?.FromFull?.Email
  if (typeof full === 'string' && full.includes('@')) return full.trim().toLowerCase()
  const m = String(payload?.From || '').match(/<([^>]+)>/)
  return (m ? m[1] : String(payload?.From || '')).trim().toLowerCase()
}

/** Match `proj-<prefix>@<domain>` as the WHOLE address (not a suffix of another address). */
export function matchGuardianAddress(header: string, domain: string): string | null {
  const esc = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = String(header || '').match(new RegExp(`(?<![a-z0-9._%+-])proj-([a-z0-9]+)@${esc}(?![a-z0-9.-])`, 'i'))
  return m ? m[1].toLowerCase() : null
}
