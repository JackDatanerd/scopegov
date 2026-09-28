import { describe, it, expect } from 'vitest'
import {
  isSowLanguage, sowLanguageName, sectionTitle,
  buildBoilerplateSections, buildFallbackSections, buildFallbackTables,
  type SowContentInput,
} from '@/lib/ai/sow-content'

// FIX (fresh independent audit, section 4, bug B5): every one of these lookups used to be
// `code in SOW_LANGUAGE_NAMES` or a bare `SOME_MAP[code]`, both of which walk the prototype
// chain — 'toString', 'constructor', 'hasOwnProperty' etc. all read as "present" even though
// they were never one of the six real language codes. workspace/defaults accepted such a value
// and persisted it to workspaces.sow_language; every generation path below then had to cope
// with that already-bad value reaching it. isSowLanguage/sowLanguageName use
// Object.prototype.hasOwnProperty.call so these all resolve to the real 'en' fallback instead.
const PROTO_KEYS = ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']

const baseInput: SowContentInput = {
  agencyName: 'Acme Agency', clientName: 'Client Co', projectName: 'Website',
  projectType: 'web', contractValue: 1000, currency: 'USD',
  paymentLabel: '50% upfront / 50% on delivery', paymentStructure: '50_50',
  revisionRounds: 2, governingLaw: 'Republic of Kenya',
  deliverables: 'A homepage', timeline: '4 weeks',
}

describe('isSowLanguage / sowLanguageName', () => {
  it('accepts only the six real language codes', () => {
    expect(isSowLanguage('en')).toBe(true)
    expect(isSowLanguage('sw')).toBe(true)
    expect(sowLanguageName('fr')).toBe('French')
  })

  it('rejects every JS Object prototype key', () => {
    for (const key of PROTO_KEYS) {
      expect(isSowLanguage(key)).toBe(false)
      expect(sowLanguageName(key)).toBeUndefined()
    }
  })

  it('rejects non-string and empty input', () => {
    expect(isSowLanguage(undefined)).toBe(false)
    expect(isSowLanguage(null)).toBe(false)
    expect(isSowLanguage(123)).toBe(false)
    expect(isSowLanguage('')).toBe(false)
  })
})

describe('generation helpers fall back to English instead of throwing/breaking on a prototype key', () => {
  for (const key of PROTO_KEYS) {
    it(`buildBoilerplateSections('${key}') behaves exactly like English, not like a function reference`, () => {
      const withEn = buildBoilerplateSections({ ...baseInput, language: 'en' })
      const withKey = buildBoilerplateSections({ ...baseInput, language: key })
      // Before the fix, BOILERPLATE_TEMPLATES[key] resolved to Object.prototype's own
      // 'toString'/'constructor' etc. — a function, so the `|| BOILERPLATE_TEMPLATES.en`
      // fallback never even fired, and calling it as template(agency, client, law) either threw
      // or returned garbage instead of the real English boilerplate sections.
      expect(withKey).toEqual(withEn)
    })

    it(`buildFallbackSections('${key}') matches the English fallback`, () => {
      expect(buildFallbackSections({ ...baseInput, language: key }))
        .toEqual(buildFallbackSections({ ...baseInput, language: 'en' }))
    })

    it(`buildFallbackTables('${key}') matches the English fallback`, () => {
      expect(buildFallbackTables({ ...baseInput, language: key }))
        .toEqual(buildFallbackTables({ ...baseInput, language: 'en' }))
    })

    it(`sectionTitle('parties', '${key}') falls back to the English title`, () => {
      expect(sectionTitle('parties', key)).toBe(sectionTitle('parties', 'en'))
    })
  }
})
