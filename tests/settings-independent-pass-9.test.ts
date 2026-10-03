import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const client = readFileSync('components/settings/SettingsClient.tsx', 'utf8')
const defaultsRoute = readFileSync('app/api/workspace/defaults/route.ts', 'utf8')
const settingsRoute = readFileSync('app/api/workspace/settings/route.ts', 'utf8')

describe('Settings independent pass 9', () => {
  it('signature save/remove carry the stale-workspace guard', () => {
    const save = client.slice(client.indexOf('saveSignature'))
    expect(save).toMatch(/\.\.\.\(workspaceId \? \{ workspaceId \} : \{\}\)/)
    expect((client.match(/\.\.\.\(workspaceId \? \{ workspaceId \} : \{\}\)/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it('signature pad ink is fixed dark, not the brand colour', () => {
    expect(client).toContain('strokeColour="#111827"')
    expect(client).not.toContain('strokeColour={colour}')
  })

  it('global defaults save is concurrency-protected end to end', () => {
    expect(defaultsRoute).toContain('class DefaultsConflictError')
    expect(defaultsRoute).toContain('expectedUpdatedAt')
    expect(defaultsRoute).toContain('sameInstant')
    expect(defaultsRoute).toMatch(/updatedAt/)
    expect(defaultsRoute).toMatch(/DefaultsConflictError[\s\S]*409/)
    expect(client).toContain('expectedUpdatedAt')
    expect(client).toContain('defaultsBase')
  })

  it('reminder tuning fields are not sent while reminders are off', () => {
    expect(client).toContain('function saveForm()')
    expect(client).toMatch(/form\.autoClientReminders \? form : rest/)
    expect(client).not.toContain("onSave('/api/workspace/settings', form)")
  })

  it('blank default tax rate is sent as null, not coerced to 0', () => {
    expect(client).toMatch(/case 'defaultTaxRate':\s+return trimText\(value\) === '' \? null/)
  })

  it('settings PATCH retries the write when only unrelated columns moved updated_at', () => {
    expect(settingsRoute).toContain('attemptWrite')
    expect(settingsRoute).toContain('sameValue(fresh[col], (current as any)[col])')
  })
})
