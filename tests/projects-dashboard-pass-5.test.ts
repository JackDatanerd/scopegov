// tests/projects-dashboard-pass-5.test.ts
//
// Projects & Dashboard (section 7) independent pass 5 — source-level regression guards:
//   B1  discussion composer: submit() has a catch and tolerates a non-JSON error body
//   B2  Projects list follows ?filter= when the URL changes while the component stays mounted
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('B1 discussion composer submit()', () => {
  const s = src('components/projects/ProjectDiscussion.tsx')
  const submit = s.slice(s.indexOf('async function submit()'), s.indexOf('function startEdit'))
  it('parses the response defensively', () => {
    expect(submit).toMatch(/await res\.json\(\)\.catch\(/)
    expect(submit).not.toMatch(/await res\.json\(\)\s*\n/)
  })
  it('catches a thrown fetch and shows an error', () => {
    expect(submit).toMatch(/\} catch \{\s*\n\s*setError\('Could not send that message/)
    expect(submit).toMatch(/finally \{ setPosting\(false\) \}/)
  })
  it('keeps the draft on failure (clears it only after a successful post)', () => {
    expect(submit.indexOf('setDraft(\'\')')).toBeGreaterThan(submit.indexOf('setMessages(prev'))
  })
})

describe('B2 ProjectsClient follows ?filter=', () => {
  const s = src('components/projects/ProjectsClient.tsx')
  it('imports useEffect', () => {
    expect(s).toMatch(/import \{ useState, useMemo, useEffect \} from 'react'/)
  })
  it('re-syncs the attention toggle and tab when initialFilter changes', () => {
    expect(s).toMatch(/useEffect\(\(\) => \{\s*\n\s*setAttentionOnly\(initialFilter === 'attention'\)\s*\n\s*setTab\(initialFilter === 'attention' \? 'all' : 'active'\)\s*\n\s*\}, \[initialFilter\]\)/)
  })
})
