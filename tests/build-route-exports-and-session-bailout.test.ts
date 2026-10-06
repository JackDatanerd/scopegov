import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { isNextControlFlowError } from '@/lib/auth/session'

const root = join(__dirname, '..')
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

// `next build` fails type-checking ("is not a valid Route export field") if a route.ts exports anything
// other than HTTP handlers and route-segment config. Unit tests import routes directly, so this is invisible
// until the Vercel build — this test is the local tripwire.
const ROUTE_ALLOWED = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|runtime|dynamic|revalidate|fetchCache|preferredRegion|maxDuration|dynamicParams|generateStaticParams)$/

describe('Next.js build contracts', () => {
  it('every route.ts exports only valid Route fields', () => {
    const bad: string[] = []
    for (const f of walk(join(root, 'app')).filter(f => /[\\/]route\.tsx?$/.test(f))) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        if (!ROUTE_ALLOWED.test(m[1])) bad.push(`${f.replace(root, '')}: ${m[1]}`)
      }
      if (/^export\s*\{/m.test(src)) bad.push(`${f.replace(root, '')}: export { ... }`)
    }
    expect(bad).toEqual([])
  })

  it('session lookup lets Next control-flow errors through instead of wrapping them as an outage', () => {
    expect(isNextControlFlowError(Object.assign(new Error('Dynamic server usage'), { digest: 'DYNAMIC_SERVER_USAGE' }))).toBe(true)
    expect(isNextControlFlowError({ digest: 'NEXT_REDIRECT;replace;/login;307;' })).toBe(true)
    expect(isNextControlFlowError({ digest: 'NEXT_NOT_FOUND' })).toBe(true)
    expect(isNextControlFlowError({ digest: 'BAILOUT_TO_CLIENT_SIDE_RENDERING' })).toBe(true)
    expect(isNextControlFlowError(new Error('fetch failed'))).toBe(false)
    expect(isNextControlFlowError(null)).toBe(false)
    expect(isNextControlFlowError('boom')).toBe(false)
    const src = readFileSync(join(root, 'lib/auth/session.ts'), 'utf8')
    expect(src.indexOf('if (isNextControlFlowError(err)) throw err')).toBeGreaterThan(-1)
    expect(src.indexOf('if (isNextControlFlowError(err)) throw err')).toBeLessThan(src.indexOf('throw new SessionUnavailableError(err instanceof Error'))
  })
})
