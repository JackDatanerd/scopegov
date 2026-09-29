import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Regression: app/(app)/projects/[id]/page.tsx once had `// FIX ...` comment
// lines pasted INSIDE its .select(`...`) template literal. PostgREST receives
// that text verbatim, rejects the query, `project` comes back null and
// notFound() fires, so every project detail page returned 404. It happened
// twice. Any `//` line inside a select template literal is a bug.

const ROOTS = ['app', 'lib', 'components']

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('PostgREST select() template literals', () => {
  it('contain no // comment lines', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      if (!fs.existsSync(root)) continue
      for (const file of walk(root)) {
        const src = fs.readFileSync(file, 'utf8')
        const re = /\.select\(\s*`([^`]*)`/g
        let m: RegExpExecArray | null
        while ((m = re.exec(src)) !== null) {
          const lines: string[] = m[1].split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (/^\s*\/\//.test(lines[i])) {
              const at = src.slice(0, m.index).split('\n').length + i
              offenders.push(`${file}:${at}  ${lines[i].trim().slice(0, 70)}`)
            }
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('project detail page select is comment-free', () => {
    const src = fs.readFileSync('app/(app)/projects/[id]/page.tsx', 'utf8')
    const m = src.match(/\.from\('projects'\)\s*\.select\(`([^`]*)`/)
    expect(m).not.toBeNull()
    expect(m![1]).not.toMatch(/\/\//)
  })
})
