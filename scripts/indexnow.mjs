// Tells IndexNow search engines (Bing, Yandex, Naver, Seznam, Yep — and through Bing: Yahoo, DuckDuckGo, Ecosia) about
// new or changed URLs. Google does NOT take part in IndexNow; it picks pages up from the sitemap submitted once in
// Search Console.
//
// Runs after every production deploy (.github/workflows/indexnow.yml) or by hand:
//   node scripts/indexnow.mjs                      submit new/changed URLs from the live sitemap
//   DRY_RUN=1 node scripts/indexnow.mjs            show what would be sent, send nothing
//   FORCE_ALL=1 node scripts/indexnow.mjs          resubmit everything (ignores the saved state)
//
// "New or changed" = a URL not seen before, or whose <lastmod> differs from the one last submitted. State is a small
// JSON file (STATE_FILE, default .indexnow-state.json) that the workflow keeps in the Actions cache. With no state the
// whole sitemap is submitted once. The key is public by design (it is served from /public); it only proves ownership.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ENDPOINT = 'https://api.indexnow.org/indexnow'
const MAX_URLS_PER_POST = 10000

/** Extracts { loc, lastmod } entries (and child sitemap locs) from sitemap XML. Tolerates CDATA and XML entities. */
export function parseSitemap(xml) {
  const unescape = (s) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim()
  const pick = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))
    return m ? unescape(m[1]) : undefined
  }
  const urls = []
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = pick(m[1], 'loc')
    if (loc) urls.push({ loc, lastmod: pick(m[1], 'lastmod') })
  }
  const children = []
  for (const m of xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)) {
    const loc = pick(m[1], 'loc')
    if (loc) children.push(loc)
  }
  return { urls, children }
}

/** state: { [url]: lastmod | '' }. Returns the URLs to submit. */
export function diffUrls(entries, state, forceAll = false) {
  const out = []
  for (const e of entries) {
    const seen = Object.prototype.hasOwnProperty.call(state, e.loc)
    if (forceAll || !seen || (e.lastmod !== undefined && state[e.loc] !== e.lastmod)) out.push(e.loc)
  }
  return out
}

export function buildPayload({ host, key, keyLocation, urlList }) {
  return { host, key, keyLocation, urlList }
}

/** The key is the name of the single <32 hex>.txt file in public/. */
export function findKey(publicDir) {
  const files = readdirSync(publicDir).filter((f) => /^[a-f0-9]{32}\.txt$/.test(f))
  if (files.length !== 1) throw new Error(`expected exactly one IndexNow key file (<32 hex chars>.txt) in ${publicDir}, found ${files.length}`)
  const key = files[0].replace(/\.txt$/, '')
  const body = readFileSync(join(publicDir, files[0]), 'utf8').trim()
  if (body !== key) throw new Error(`${files[0]} must contain exactly its own file name (the key); it contains something else`)
  return key
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ScopeGov-IndexNow/1.0' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.text()
}

async function collect(sitemapUrl, depth = 0) {
  const { urls, children } = parseSitemap(await fetchText(sitemapUrl))
  if (depth >= 2) return urls
  for (const child of children) urls.push(...(await collect(child, depth + 1)))
  return urls
}

async function main() {
  const site = (process.env.SITE_URL || 'https://www.scopegov.app').replace(/\/+$/, '')
  const host = new URL(site).host
  const stateFile = process.env.STATE_FILE || '.indexnow-state.json'
  const dryRun = !!process.env.DRY_RUN
  const forceAll = !!process.env.FORCE_ALL

  const key = findKey(join(process.cwd(), 'public'))
  const keyLocation = `${site}/${key}.txt`

  // Fail early and clearly if the key file is not actually reachable by crawlers (the usual cause: middleware
  // redirecting the .txt to /login, or the deploy not live yet).
  const served = (await fetchText(keyLocation)).trim()
  if (served !== key) throw new Error(`${keyLocation} does not serve the key — IndexNow would reject every submission`)

  const entries = (await collect(`${site}/sitemap.xml`)).filter((e) => {
    try { return new URL(e.loc).host === host } catch { return false } // IndexNow only accepts URLs on the key's host
  })
  const state = !forceAll && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
  const toSend = diffUrls(entries, state, forceAll)

  console.log(`sitemap: ${entries.length} URL(s); new or changed: ${toSend.length}`)
  if (toSend.length === 0) { console.log('Nothing to submit.'); return }
  if (dryRun) { for (const u of toSend) console.log('  would submit', u); return }

  for (let i = 0; i < toSend.length; i += MAX_URLS_PER_POST) {
    const chunk = toSend.slice(i, i + MAX_URLS_PER_POST)
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(buildPayload({ host, key, keyLocation, urlList: chunk })),
    })
    // 200 = received, 202 = received and key validation pending. Anything else means NOTHING was accepted.
    if (res.status !== 200 && res.status !== 202) {
      throw new Error(`IndexNow rejected the submission: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    }
    console.log(`submitted ${chunk.length} URL(s): HTTP ${res.status}`)
  }

  const next = { ...state }
  for (const e of entries) if (toSend.includes(e.loc)) next[e.loc] = e.lastmod ?? ''
  writeFileSync(stateFile, JSON.stringify(next, null, 2) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
}
