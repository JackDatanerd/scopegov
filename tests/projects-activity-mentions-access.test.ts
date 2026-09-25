import { describe, it, expect } from 'vitest'
import { describeActivity, shapeActivityRow, DASHBOARD_NOISE_EVENT_PATTERNS } from '@/lib/utils/activity-format'
import {
  extractMentions, tokensToDisplay, displayToTokens, resolveMentions, listMentionable,
} from '@/lib/utils/project-messages'
import { canReadProject } from '@/lib/utils/project-access'

const row = (over: any) => ({ id: 'a1', event_type: 'project.updated', created_at: '2026-09-24T10:00:00Z', ...over })

describe('activity formatter', () => {
  it('reads a status change from the flat shape AND from legacy rows (metadata.status.{from,to})', () => {
    const flat = describeActivity(row({ event_type: 'project.status_changed', actor_name: 'Alice', metadata: { from: 'Active', to: 'Stalled' } }), { viewFinancials: false })
    const legacy = describeActivity(row({ event_type: 'project.status_changed', actor_name: 'Alice', metadata: { status: { from: 'Active', to: 'Stalled' } } }), { viewFinancials: false })
    expect(flat).toEqual({ actor: 'Alice', text: 'paused the project' })
    expect(legacy).toEqual(flat)
  })

  it('resume and other transitions', () => {
    expect(describeActivity(row({ event_type: 'project.status_changed', actor_name: 'A', metadata: { from: 'Stalled', to: 'Active' } }), { viewFinancials: false }).text)
      .toBe('resumed the project')
    expect(describeActivity(row({ event_type: 'project.status_changed', actor_name: 'A', metadata: {} }), { viewFinancials: false }).text)
      .toBe('changed the project status')
  })

  it('names the fields an edit touched, never their values', () => {
    const d = describeActivity(row({ actor_name: 'Bo', metadata: { contractValue: { from: 1, to: 2 }, name: { from: 'a', to: 'b' } } }), { viewFinancials: false })
    expect(d.text).toBe('edited the project (contract value, name)')
    expect(d.text).not.toMatch(/\d/)
  })

  it('a system event has no actor prefix; a client event without a name says "Client" — never a blank or "System signed"', () => {
    expect(describeActivity(row({ event_type: 'sow.expired' }), { viewFinancials: false })).toEqual({ actor: '', text: 'SOW expired unsigned' })
    expect(describeActivity(row({ event_type: 'sow.signed', actor_name: null }), { viewFinancials: false })).toEqual({ actor: 'Client', text: 'signed the SOW' })
    expect(describeActivity(row({ event_type: 'project.created', actor_name: null }), { viewFinancials: false }).actor).toBe('System')
  })

  it('an unknown event still renders something readable', () => {
    expect(describeActivity(row({ event_type: 'brand_new.thing_happened', actor_name: 'Z' }), { viewFinancials: false }).text)
      .toBe('brand new thing_happened'.replace('thing_happened', 'thing happened'))
  })

  it('money only appears for VIEW_FINANCIALS', () => {
    const e = row({ event_type: 'project.retainer_renewed', actor_name: 'A', metadata: { new_monthly_amount: 3000, currency: 'USD' } })
    expect(describeActivity(e, { viewFinancials: true }).text).toBe('renewed the retainer at USD 3000/mo')
    expect(describeActivity(e, { viewFinancials: false }).text).toBe('renewed the retainer')
  })

  it('the workspace feed appends the project name; scope adjustments carry a detail line', () => {
    const shaped = shapeActivityRow(row({ event_type: 'invoice.sent', actor_name: 'Al', entity_name: 'INV-7' }), { viewFinancials: false, projectName: 'Acme site' })
    expect(shaped.text).toBe('sent invoice INV-7 — Acme site')
    const adj = shapeActivityRow(row({ event_type: 'project.scope_adjustment_made', actor_name: 'Al', metadata: { field: 'deliverable', old_value: 'A', new_value: 'B', reason: 'client ask' } }), { viewFinancials: false })
    expect(adj.detail).toBe('Changed deliverable “A” → “B” — client ask')
  })

  it('machinery events are on the dashboard noise list', () => {
    expect(DASHBOARD_NOISE_EVENT_PATTERNS).toEqual(expect.arrayContaining(['check.%', '%.link_viewed', 'reminder.%']))
  })
})

describe('mention tokens', () => {
  const ID = '11111111-1111-1111-1111-111111111111'

  it('extractMentions normalises id case so one person is not notified twice', () => {
    const body = `hi @[Al](${ID.toUpperCase()}) and @[Al](${ID})`
    expect(extractMentions(body)).toEqual([{ userId: ID, displayName: 'Al' }])
  })

  it('composer round-trip: names with spaces / regex characters convert to tokens and back', () => {
    const picked = { 'Alice Smith': ID, 'Al (Ops)': '22222222-2222-2222-2222-222222222222' }
    const text = 'ping @Alice Smith and @Al (Ops), thanks. Not @Alice alone'
    const tokens = displayToTokens(text, picked)
    expect(tokens).toContain(`@[Alice Smith](${ID})`)
    expect(tokens).toContain('@[Al (Ops)](22222222-2222-2222-2222-222222222222)')
    expect(tokens).toContain('Not @Alice alone') // a partial, un-picked name is left alone
    const back = tokensToDisplay(tokens)
    expect(back.text).toBe(text)
    expect(back.picked['Alice Smith']).toBe(ID)
  })

  it('does not convert a picked name that was edited into a longer word', () => {
    const tokens = displayToTokens('hey @Alicent', { Alice: ID })
    expect(tokens).toBe('hey @Alicent')
  })
})

// ── fake supabase for mention resolution ─────────────────────────────────────────────────────────
function mentionService(opts: { team: string[]; members: Array<{ user_id: string; name: string; admin?: boolean }> }) {
  return {
    from(table: string) {
      const result = table === 'project_members_active'
        ? { data: opts.team.map(id => ({ member_user_id: id })) }
        : { data: opts.members.map(m => ({
            user_id: m.user_id,
            effective_permissions: m.admin ? { VIEW_ALL_PROJECTS: true } : {},
            users: { id: m.user_id, name: m.name, email: `${m.name}@x.io`, avatar_url: null },
          })) }
      const b: any = {}
      for (const m of ['select', 'eq']) b[m] = () => b
      b.then = (resolve: any) => resolve(result)
      return b
    },
  }
}

describe('mention resolution', () => {
  const ALICE = '11111111-1111-1111-1111-111111111111'
  const BOB = '22222222-2222-2222-2222-222222222222'
  const ADMIN = '33333333-3333-3333-3333-333333333333'
  const STRANGER = '44444444-4444-4444-4444-444444444444'
  const svc = mentionService({
    team: [ALICE, BOB],
    members: [
      { user_id: ALICE, name: 'Alice' }, { user_id: BOB, name: 'Bob' },
      { user_id: ADMIN, name: 'Owen Owner', admin: true }, { user_id: STRANGER, name: 'Sam Stranger' },
    ],
  })

  it('mentionable = the assigned team PLUS everyone who can see every project', async () => {
    const list = await listMentionable(svc, 'w', 'p')
    expect(list.map(p => p.name).sort()).toEqual(['Alice', 'Bob', 'Owen Owner'])
  })

  it('an admin who is not on the team can be @mentioned', async () => {
    const r = await resolveMentions(svc, 'w', 'p', `cc @[Owen Owner](${ADMIN})`)
    expect(r.mentions.map(m => m.userId)).toEqual([ADMIN])
  })

  it('the token is rewritten to the REAL name: "@[Alice](bob-id)" can no longer show Alice while notifying Bob', async () => {
    const r = await resolveMentions(svc, 'w', 'p', `hi @[Alice](${BOB})`)
    expect(r.mentions).toEqual([{ userId: BOB, displayName: 'Bob' }])
    expect(r.body).toBe(`hi @[Bob](${BOB})`)
  })

  it('a token for someone who cannot see the project degrades to plain text and notifies nobody', async () => {
    const r = await resolveMentions(svc, 'w', 'p', `psst @[Sam Stranger](${STRANGER}) look`)
    expect(r.mentions).toEqual([])
    expect(r.body).toBe('psst @Sam Stranger look')
  })

  it('a body with no mentions is returned untouched without querying', async () => {
    const r = await resolveMentions({ from() { throw new Error('should not query') } }, 'w', 'p', 'plain text')
    expect(r).toEqual({ mentions: [], body: 'plain text' })
  })
})

describe('canReadProject — VIEW_ALL is per WORKSPACE, not global', () => {
  const admin: any = { id: 'u', workspaceId: 'ws-A', permissions: ['VIEW_ALL_PROJECTS'] }
  const svcFor = (projectWorkspace: string) => ({
    from() {
      const filters: Record<string, string> = {}
      const b: any = {}
      b.select = () => b
      b.eq = (col: string, val: string) => { filters[col] = val; return b }
      b.limit = () => Promise.resolve({ data: filters.workspace_id === projectWorkspace && filters.id === 'proj' ? [{ id: 'proj' }] : [], error: null })
      return b
    },
  })

  it('true for a project in the caller\'s workspace', async () => {
    expect(await canReadProject(svcFor('ws-A'), admin, 'proj')).toBe(true)
  })
  it('false for another workspace\'s project (this used to return true for any id)', async () => {
    expect(await canReadProject(svcFor('ws-B'), admin, 'proj')).toBe(false)
  })
  it('false for an empty / non-string id', async () => {
    expect(await canReadProject(svcFor('ws-A'), admin, '')).toBe(false)
    expect(await canReadProject(svcFor('ws-A'), admin, undefined as any)).toBe(false)
  })
})
