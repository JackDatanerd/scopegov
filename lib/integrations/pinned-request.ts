// lib/integrations/pinned-request.ts
//
// The outbound HTTP primitive for integration deliveries. Stronger than lib/utils/safe-fetch.ts for tenant-supplied URLs:
//
//   safeFetch      resolves DNS, checks the FIRST address, then fetch() resolves again on its own. Two gaps for an
//                  attacker-controlled hostname: (1) rebinding — the second lookup can return a different address;
//                  (2) a name with several A records can pass on the public one and be connected on the private one.
//   pinnedPost     resolves ALL addresses once, refuses if ANY is private/reserved, then connects to the exact address
//                  it validated (a `lookup` override) while TLS/SNI and the Host header still use the real hostname.
//
// Redirects are never followed: a receiver that answers 3xx is misconfigured, and following it would re-open the very
// question this file exists to close. The response body is never read.

import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { isBlockedAddress } from '@/lib/utils/safe-fetch'

export interface PinnedResponse { status: number; retryAfter: string | null }
export interface PinnedDeps {
  lookupAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  isBlocked?: (address: string) => boolean
}
export class TimeoutError extends Error { name = 'TimeoutError' }

const defaultLookupAll = async (hostname: string) => dns.lookup(hostname, { all: true, verbatim: true })

/** Resolve once and return the single address to connect to, or throw if ANY resolved address is off-limits. */
export async function pickSafeAddress(hostname: string, deps: PinnedDeps = {}): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.replace(/^\[|\]$/g, '')
  const blocked = deps.isBlocked || isBlockedAddress
  const addrs = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await (deps.lookupAll || defaultLookupAll)(host)
  if (!addrs.length) throw new Error(`Could not resolve ${hostname}`)
  const bad = addrs.find(a => blocked(a.address))
  if (bad) throw new Error(`Refusing to connect to internal/reserved address: ${bad.address}`)
  return { address: addrs[0].address, family: addrs[0].family === 6 ? 6 : 4 }
}

/** A dns `lookup` that always answers with the pinned address, in whichever shape Node asks for. */
export function pinnedLookup(address: string, family: 4 | 6) {
  return (_host: string, opts: any, cb: any) => {
    const callback = typeof opts === 'function' ? opts : cb
    if (typeof opts === 'object' && opts?.all) callback(null, [{ address, family }])
    else callback(null, address, family)
  }
}

export async function pinnedPost(
  rawUrl: string,
  req: { headers: Record<string, string>; body: string; timeoutMs: number },
  deps: PinnedDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<PinnedResponse> {
  const url = new URL(rawUrl)
  const secure = url.protocol === 'https:'
  if (!secure && !(url.protocol === 'http:' && env.NODE_ENV !== 'production')) throw new Error(`Blocked protocol: ${url.protocol}`)
  if (url.username || url.password) throw new Error('Credentials in the URL are not allowed')

  const pinned = await pickSafeAddress(url.hostname, deps)
  const lib = secure ? https : http

  return new Promise<PinnedResponse>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn() } }
    const request = lib.request({
      protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined,
      path: url.pathname + url.search, method: 'POST',
      headers: { ...req.headers, 'Content-Length': String(Buffer.byteLength(req.body)) },
      lookup: pinnedLookup(pinned.address, pinned.family) as any,
      agent: false,
    }, res => {
      const ra = res.headers['retry-after']
      done(() => resolve({ status: res.statusCode || 0, retryAfter: Array.isArray(ra) ? ra[0] : ra ?? null }))
      res.destroy() // the body is not needed; do not hold the socket open for it
    })
    // One deadline for the whole exchange (connect + TLS + headers), not just socket idleness.
    const timer = setTimeout(() => { done(() => reject(new TimeoutError(`timed out after ${req.timeoutMs / 1000}s`))); request.destroy() }, req.timeoutMs)
    request.on('error', e => done(() => reject(e)))
    request.end(req.body)
  })
}
