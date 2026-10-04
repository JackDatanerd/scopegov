import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { uniqueMentionLabel, displayToTokens, extractMentions, tokensToDisplay, resolveMentions } from '@/lib/utils/project-messages'

const ID = '11111111-1111-1111-1111-111111111111'

describe('Projects & Dashboard pass 9 — mentions of names containing brackets', () => {
  it('a name with square brackets yields a token the parser can read', () => {
    const picked: Record<string, string> = {}
    const label = uniqueMentionLabel('Jane [Acme]', ID, picked)
    picked[label] = ID
    expect(label).toBe('Jane Acme')
    const body = displayToTokens(`hi @${label} there`, picked)
    expect(extractMentions(body).map(m => m.userId)).toEqual([ID])
  })

  it('parentheses are left alone (legal inside a token, and the existing composer round-trip depends on it)', () => {
    const picked: Record<string, string> = {}
    const label = uniqueMentionLabel('Jane (Acme)', ID, picked); picked[label] = ID
    expect(label).toBe('Jane (Acme)')
    expect(extractMentions(displayToTokens(`@${label} hi`, picked)).map(m => m.userId)).toEqual([ID])
  })

  it('same-name disambiguation still works after normalisation', () => {
    const a = 'aaaaaaaa-1111-1111-1111-111111111111', b = 'bbbbbbbb-1111-1111-1111-111111111111'
    const picked: Record<string, string> = {}
    const la = uniqueMentionLabel('Sam [X]', a, picked); picked[la] = a
    const lb = uniqueMentionLabel('Sam X', b, picked); picked[lb] = b
    expect(la).not.toBe(lb)
    const body = displayToTokens(`@${la} and @${lb}`, picked)
    expect(extractMentions(body).map(m => m.userId).sort()).toEqual([a, b])
  })

  it('round-trips through the edit composer', () => {
    const picked: Record<string, string> = {}
    const label = uniqueMentionLabel('Jane [Acme]', ID, picked); picked[label] = ID
    const stored = displayToTokens(`@${label} ok`, picked)
    const { text, picked: p2 } = tokensToDisplay(stored)
    expect(displayToTokens(text, p2)).toBe(stored)
  })

  it('the server resolves a bracket-name mention end to end', async () => {
    const service: any = {
      from: (t: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => t === 'project_members_active'
              ? Promise.resolve({ data: [{ member_user_id: ID }] })
              : Promise.resolve({ data: [{ user_id: ID, effective_permissions: {}, users: { id: ID, name: 'Jane [Acme]', email: 'j@a.co', avatar_url: null } }] }),
          }),
        }),
      }),
    }
    const picked: Record<string, string> = {}
    const label = uniqueMentionLabel('Jane [Acme]', ID, picked); picked[label] = ID
    const r = await resolveMentions(service, 'w', 'p', displayToTokens(`@${label} hi`, picked))
    expect(r.mentions.map(m => m.userId)).toEqual([ID])
  })
})

describe('Projects & Dashboard pass 9 — wiring', () => {
  const post = readFileSync('app/api/projects/[id]/messages/route.ts', 'utf8')
  const patch = readFileSync('app/api/projects/[id]/messages/[messageId]/route.ts', 'utf8')
  const detail = readFileSync('components/projects/ProjectDetail.tsx', 'utf8')

  it('POST checks the mention insert and rolls the message back on failure', () => {
    expect(post).toMatch(/const \{ error: mentionErr \} = await/)
    expect(post).toMatch(/from\('project_messages'\)\.delete\(\)\.eq\('id', message\.id\)/)
  })
  it('PATCH only notifies mentions that were actually stored', () => {
    expect(patch).toMatch(/if \(addErr\)/)
    expect(patch).toMatch(/else \{\s*const projectName/)
  })
  it('overview shows the type label and a truthful Guardian state', () => {
    expect(detail).toMatch(/PROJECT_TYPE_LABELS\[project\.type\] \|\| project\.type/)
    expect(detail).toMatch(/'Paused'/)
    expect(detail).toMatch(/Ended — project is closed/)
  })
})
