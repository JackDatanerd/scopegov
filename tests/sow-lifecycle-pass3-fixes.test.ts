import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { hydrateSections, REQUIRED_SECTION_IDS } from '@/lib/sow/sections'
import { NOTO_SANS_SUPPORTED_RANGES } from '@/lib/pdf/fonts/noto-sans-data'

const root = path.resolve(__dirname, '..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')
const inFont = (cp: number) => NOTO_SANS_SUPPORTED_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)

describe('SOW lifecycle pass 3', () => {
  it('nested list bullets only use glyphs the embedded PDF font has', () => {
    const src = read('lib/pdf/rich-text.tsx')
    const m = src.match(/const NESTED_BULLETS = \[(.*?)\]/)
    expect(m).toBeTruthy()
    const glyphs = [...m![1].matchAll(/'((?:\\u[0-9A-Fa-f]{4})|[^'])'/g)].map(x =>
      x[1].startsWith('\\u') ? parseInt(x[1].slice(2), 16) : x[1].codePointAt(0)!)
    expect(glyphs.length).toBe(3)
    for (const cp of glyphs) expect(inFont(cp)).toBe(true)
  })

  it('hydrateSections forces required sections visible, leaves optional ones alone', () => {
    const stored = REQUIRED_SECTION_IDS.map(id => ({ id, visible: false, content: '<p>x</p>' }))
    stored.push({ id: 'timeline', visible: false, content: '<p>y</p>' })
    const out = hydrateSections(stored, { language: 'en', paymentStructure: '50_50' })
    for (const id of REQUIRED_SECTION_IDS) expect(out.find(s => s.id === id)!.visible).toBe(true)
    expect(out.find(s => s.id === 'timeline')?.visible).toBe(false)
  })

  it('the executed-PDF render at signing hydrates sections but hashes the raw ones', () => {
    const src = read('app/api/portal/sow/[token]/sign/route.ts')
    expect(src).toMatch(/sections:\s+hydrateSections\(sow\.sections \|\| \[\], sow\.metadata\)/)
    expect(src).toMatch(/kind: 'sow'[\s\S]*?sections: sow\.sections \|\| \[\]/)
  })
})
