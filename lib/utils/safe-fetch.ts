// lib/utils/safe-fetch.ts
//
// FIX (ScopeGov audit round 1): resolveLogoDataUri() in lib/pdf/renderer.tsx
// did a raw fetch(url) with no SSRF hardening — no scheme allowlist, no
// private/internal IP blocking, and fetch's automatic redirect-following
// meant even a validated public URL could hop to an internal target on
// the second request. Same bug class as the PDF-logo SSRF fixed in
// ScopeShield (NAT64, redirect-follow, IPv6-mapped bypasses).
//
// Today the only real caller feeds this Supabase-storage-constructed
// URLs, so blast radius is limited — but it's a shared primitive, so it
// gets the same guard as everywhere else rather than relying on callers
// to stay well-behaved forever.
//
// safeFetch() resolves DNS itself, rejects private/reserved/loopback/
// link-local targets (covers the classic 169.254.169.254 cloud metadata
// case and its IPv6-mapped / NAT64 forms), and re-validates on every hop
// of a redirect chain instead of trusting fetch's built-in follow.
// Deliberately dependency-free (Node's own dns/net modules only) so it
// doesn't add a new package to the build for something this small.

import dns from 'node:dns/promises'
import net from 'node:net'

const MAX_REDIRECTS = 5
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

// IPv4 ranges that must never be reachable from a server-side fetch.
const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local — includes cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved
]

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0
}

function ipv4InRange(ip: string, range: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask)
}

function isBlockedV4(ip: string): boolean {
  return BLOCKED_V4_RANGES.some(([range, bits]) => ipv4InRange(ip, range, bits))
}

// Expand a v6 address to its 8 hextet groups (handles "::" compression
// AND the canonical dotted-quad tail Node's dns.lookup returns for
// IPv4-mapped addresses, e.g. "::ffff:169.254.169.254" — the dotted
// quad is NOT four more colon-separated hex groups, it's the last 32
// bits written as an embedded IPv4 literal, and must be converted to
// two hextets before the rest of this function ever sees it.
function expandV6(ip: string): number[] {
  let clean = ip.split('%')[0] // strip zone id if present

  const dottedQuad = clean.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dottedQuad && net.isIP(dottedQuad[1]) === 4) {
    const [a, b, c, d] = dottedQuad[1].split('.').map(Number)
    const hex1 = ((a << 8) | b).toString(16)
    const hex2 = ((c << 8) | d).toString(16)
    clean = clean.slice(0, clean.length - dottedQuad[1].length) + `${hex1}:${hex2}`
  }

  if (clean.includes('::')) {
    const [head, tail] = clean.split('::')
    const headParts = head ? head.split(':').filter(Boolean).map(h => parseInt(h, 16)) : []
    const tailParts = tail ? tail.split(':').filter(Boolean).map(h => parseInt(h, 16)) : []
    const missing = 8 - headParts.length - tailParts.length
    return [...headParts, ...Array(Math.max(missing, 0)).fill(0), ...tailParts]
  }
  return clean.split(':').map(h => parseInt(h, 16))
}

function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip)
  if (version === 4) return isBlockedV4(ip)
  if (version === 6) {
    const groups = expandV6(ip)
    if (groups.length !== 8 || groups.some(Number.isNaN)) return true // unparsable — fail closed

    // IPv4-mapped: ::ffff:a.b.c.d  → groups[0..4]=0, groups[5]=0xffff
    if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) {
      const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
      return isBlockedV4(v4)
    }
    // NAT64 well-known prefix: 64:ff9b::/96
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0)) {
      const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
      return isBlockedV4(v4)
    }
    // Loopback ::1
    if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) return true
    // Link-local fe80::/10
    if ((groups[0] & 0xffc0) === 0xfe80) return true
    // Unique local fc00::/7 (covers fc00.. and fd00..)
    if ((groups[0] & 0xfe00) === 0xfc00) return true
    // Multicast ff00::/8
    if ((groups[0] & 0xff00) === 0xff00) return true
    return false
  }
  return true // couldn't parse as IPv4 or IPv6 — fail closed
}

async function assertHostIsSafe(hostname: string): Promise<void> {
  // Resolve every hostname (including bare IP literals, which dns.lookup
  // passes through) so decimal/octal/hex IP encodings and hostnames
  // alike get the same check.
  const { address } = await dns.lookup(hostname, { verbatim: true })
  if (isBlockedAddress(address)) {
    throw new Error(`Refusing to fetch internal/reserved address: ${address}`)
  }
}

/**
 * Fetch a URL with SSRF protections: scheme allowlist, DNS-resolved
 * private/reserved IP blocking, and per-hop redirect re-validation.
 * Throws on any unsafe target instead of silently following it.
 */
export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let current = new URL(url)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!ALLOWED_PROTOCOLS.has(current.protocol)) {
      throw new Error(`Blocked protocol: ${current.protocol}`)
    }
    await assertHostIsSafe(current.hostname)

    const res = await fetch(current.toString(), { ...init, redirect: 'manual' })

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location')
      if (!location) throw new Error('Redirect with no Location header')
      current = new URL(location, current)
      continue
    }
    return res
  }
  throw new Error('Too many redirects')
}
