// Guards the step that is easiest to forget: every article file must be registered in lib/help/index.ts, and every registered article must have a file.
// An unregistered article file is invisible in /help, so this fails the suite instead of failing silently.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { ARTICLES } from '@/lib/help'

const dir = join(process.cwd(), 'lib/help/articles')
const files = readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => f.replace(/\.ts$/, '')).sort()

describe('help registry is complete', () => {
  it('registers every article file (an unregistered file never appears in /help)', () => {
    const index = readFileSync(join(process.cwd(), 'lib/help/index.ts'), 'utf8')
    const missing = files.filter(f => !index.includes(`'./articles/${f}'`))
    expect(missing, `article files not imported in lib/help/index.ts: ${missing.join(', ')}`).toEqual([])
  })

  it('puts every imported article into ARTICLES', () => {
    const index = readFileSync(join(process.cwd(), 'lib/help/index.ts'), 'utf8')
    const imported = [...index.matchAll(/^import \{ (\w+) \} from '\.\/articles\/[^']+'/gm)].map(m => m[1])
    const arrayBody = index.match(/export const ARTICLES: HelpArticle\[\] = \[\n([\s\S]*?)\n\]/)?.[1] ?? ''
    const notListed = imported.filter(name => !new RegExp(`\\b${name},`).test(arrayBody))
    expect(notListed, `imported but not in ARTICLES: ${notListed.join(', ')}`).toEqual([])
  })

  it('has exactly one registered article per file', () => {
    expect(ARTICLES.length).toBe(files.length)
  })
})
