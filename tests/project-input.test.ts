import { describe, it, expect } from 'vitest'
import {
  parseProjectName, parseOptionalText, parseProjectType, parseContractValue,
  parseCurrencyCode, parseStartDate, parseRetainerMonths, MAX_PROJECT_NAME,
} from '@/lib/utils/project-input'
import {
  LIMIT_COUNTED_STATUSES, IN_PROGRESS_STATUSES, isTerminalStatus, isInProgressStatus,
} from '@/lib/utils/project-status'

describe('parseProjectName', () => {
  it('trims and accepts a normal name', () => {
    expect(parseProjectName('  Acme site  ')).toEqual({ ok: true, value: 'Acme site' })
  })
  it('rejects whitespace-only, non-string and over-long names', () => {
    expect(parseProjectName('   ').ok).toBe(false)
    expect(parseProjectName(42).ok).toBe(false)
    expect(parseProjectName(undefined).ok).toBe(false)
    expect(parseProjectName('x'.repeat(MAX_PROJECT_NAME + 1)).ok).toBe(false)
  })
})

describe('parseContractValue', () => {
  it('accepts numbers and numeric strings, rounding to cents', () => {
    expect(parseContractValue(1250)).toEqual({ ok: true, value: 1250 })
    expect(parseContractValue('12,500.505')).toMatchObject({ ok: true })
    expect(parseContractValue('  99.5 ')).toEqual({ ok: true, value: 99.5 })
  })
  it('treats empty as 0', () => {
    expect(parseContractValue('')).toEqual({ ok: true, value: 0 })
    expect(parseContractValue(null)).toEqual({ ok: true, value: 0 })
  })
  it('rejects NaN, Infinity, negatives, junk and absurd values', () => {
    expect(parseContractValue(NaN).ok).toBe(false)
    expect(parseContractValue(Infinity).ok).toBe(false)
    expect(parseContractValue(-1).ok).toBe(false)
    expect(parseContractValue('-500').ok).toBe(false)
    expect(parseContractValue('12abc').ok).toBe(false)
    expect(parseContractValue({}).ok).toBe(false)
    expect(parseContractValue(1e15).ok).toBe(false)
  })
})

describe('parseCurrencyCode / parseProjectType', () => {
  it('normalises currency to upper case and rejects non-codes', () => {
    expect(parseCurrencyCode(' kes ')).toEqual({ ok: true, value: 'KES' })
    expect(parseCurrencyCode('US$').ok).toBe(false)
    expect(parseCurrencyCode(5).ok).toBe(false)
  })
  it('only accepts known project types', () => {
    expect(parseProjectType('retainer').ok).toBe(true)
    expect(parseProjectType('nonsense').ok).toBe(false)
  })
})

describe('parseStartDate / parseRetainerMonths / parseOptionalText', () => {
  it('accepts real calendar dates only', () => {
    expect(parseStartDate('2026-09-19')).toEqual({ ok: true, value: '2026-09-19' })
    expect(parseStartDate('2026-02-30').ok).toBe(false)
    expect(parseStartDate('19/09/2026').ok).toBe(false)
    expect(parseStartDate('')).toEqual({ ok: true, value: null })
  })
  it('bounds retainer months', () => {
    expect(parseRetainerMonths('12')).toEqual({ ok: true, value: 12 })
    expect(parseRetainerMonths(0).ok).toBe(false)
    expect(parseRetainerMonths(61).ok).toBe(false)
    expect(parseRetainerMonths('1.5').ok).toBe(false)
    expect(parseRetainerMonths(null)).toEqual({ ok: true, value: null })
  })
  it('trims optional text and enforces the cap', () => {
    expect(parseOptionalText('  hi ', 'X', 10)).toEqual({ ok: true, value: 'hi' })
    expect(parseOptionalText('   ', 'X', 10)).toEqual({ ok: true, value: null })
    expect(parseOptionalText('x'.repeat(11), 'X', 10).ok).toBe(false)
    expect(parseOptionalText(5, 'X', 10).ok).toBe(false)
  })
})

describe('project status groupings', () => {
  it('finished projects never count toward the plan allowance', () => {
    expect(LIMIT_COUNTED_STATUSES).not.toContain('Complete')
    expect(LIMIT_COUNTED_STATUSES).not.toContain('Archived')
    // drafts DO count — they are deletable, which is how a slot is freed
    expect(LIMIT_COUNTED_STATUSES).toContain('Draft')
  })
  it('in-progress includes Stalled but not Draft or finished projects', () => {
    expect(isInProgressStatus('Stalled')).toBe(true)
    expect(isInProgressStatus('Draft')).toBe(false)
    expect(isInProgressStatus('Complete')).toBe(false)
    expect(IN_PROGRESS_STATUSES).toContain('Active')
  })
  it('terminal statuses', () => {
    expect(isTerminalStatus('Complete')).toBe(true)
    expect(isTerminalStatus('Archived')).toBe(true)
    expect(isTerminalStatus('Active')).toBe(false)
  })
})
