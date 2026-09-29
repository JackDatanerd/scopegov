import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Source-level guards for the Projects & Dashboard fix round. These read the source rather than executing
// the Next.js pages, so they stay fast and need no Supabase.

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

describe('PostgREST template strings never contain JS comments', () => {
  // A `// ...` line inside a `.select(\`...\`)` template is sent to PostgREST verbatim, the query fails, and
  // the caller sees "not found". This exact mistake once made every project detail page 404.
  it('no .select/.or/.filter template literal has a // or /* line', () => {
    const offenders: string[] = []
    for (const root of ['app', 'lib', 'components']) {
      for (const file of walk(root)) {
        const src = readFileSync(file, 'utf8')
        const re = /\.(select|or|and|filter|not|match)\(\s*(?:'[^']*',\s*)?`([^`]*)`/g
        let m: RegExpExecArray | null
        while ((m = re.exec(src))) {
          if (m[2].split('\n').some(l => /^\s*(\/\/|\/\*)/.test(l))) {
            offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('fetchPaged callers in the projects section order by a unique tiebreaker', () => {
  const files: Array<[string, RegExp]> = [
    ['app/api/projects/route.ts', /\.order\('name'\)\s*\.order\('id'\)/],
    ['app/(app)/dashboard/page.tsx', /\.order\('updated_at', \{ ascending: false \}\)\s*\.order\('id', \{ ascending: false \}\)\s*\.range/],
    ['app/(app)/projects/page.tsx', /\.order\('updated_at', \{ ascending: false \}\)\s*\.order\('id', \{ ascending: false \}\)\s*\.range/],
    ['lib/utils/contract-value.ts', /\.order\('id'\)\s*\.range\(/],
  ]
  for (const [file, re] of files) {
    it(`${file} has an id tiebreaker before .range()`, () => {
      expect(readFileSync(file, 'utf8')).toMatch(re)
    })
  }
})

describe('Discussion polling cursor is server-driven, not derived from local posts', () => {
  const src = readFileSync('components/projects/ProjectDiscussion.tsx', 'utf8')
  it('the poll and the read marker use the fetched cursor', () => {
    expect(src).toMatch(/fetchedRef\.current/)
    expect(src).toMatch(/upTo: fetchedUpTo/)
    expect(src).not.toMatch(/newestCreatedAt/)
  })
  it('submit() does not move the fetched cursor', () => {
    const submit = src.slice(src.indexOf('async function submit()'), src.indexOf('function startEdit'))
    expect(submit).not.toMatch(/fetchedRef|setFetchedUpTo/)
  })
})

describe('retainer copy', () => {
  it('does not claim open-ended retainers are not billed', () => {
    expect(readFileSync('components/projects/ProjectDetail.tsx', 'utf8')).not.toMatch(/won.{0,8}t auto-generate/)
  })
})
