import { describe, it, expect } from 'vitest'
import { createFakeSupabase } from './helpers/fake-supabase'

describe('fake supabase helper (sanity)', () => {
  it('filters, orders, pages, updates with returning, deletes', async () => {
    const { client, tables } = createFakeSupabase({ t: [{ id: 'a', n: 3, s: 'x' }, { id: 'b', n: 1, s: 'y' }, { id: 'c', n: 2, s: 'x' }] })
    const r = await (client as any).from('t').select('*').eq('s', 'x').order('n').range(0, 0)
    expect(r.data.map((x: any) => x.id)).toEqual(['c'])
    const u = await (client as any).from('t').update({ s: 'z' }).eq('id', 'a').select('id')
    expect(u.data).toEqual([{ id: 'a', n: 3, s: 'z' }])
    const d = await (client as any).from('t').delete().lt('n', 3)
    expect(d.error).toBeNull()
    expect(tables.t.map(x => x.id)).toEqual(['a'])
  })
  it('reads embedded paths, single/maybeSingle, counts, error injection and unique violations', async () => {
    const { client } = createFakeSupabase(
      { t: [{ id: 'a', projects: { deleted_at: null }, metadata: { k: 5 } }] },
      { errors: [{ table: 't', op: 'update', message: 'boom', times: 1 }], unique: (_t, row, ex) => ex.some(e => e.id === row.id) },
    )
    const q = (client as any).from('t')
    expect((await q.select('id').is('projects.deleted_at', null).eq('metadata->>k', '5').maybeSingle()).data.id).toBe('a')
    expect((await (client as any).from('t').select('id', { count: 'exact', head: true })).count).toBe(1)
    expect((await (client as any).from('t').update({ x: 1 }).eq('id', 'a')).error.message).toBe('boom')
    expect((await (client as any).from('t').update({ x: 1 }).eq('id', 'a')).error).toBeNull() // rule was one-shot
    expect((await (client as any).from('t').insert({ id: 'a' })).error.code).toBe('23505')
    expect((await (client as any).from('t').select('*').eq('id', 'zzz').single()).error.code).toBe('PGRST116')
  })
})
