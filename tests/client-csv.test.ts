import { describe, it, expect } from 'vitest'
import { csvCell } from '@/lib/utils/client-csv'

describe('csvCell (clients export)', () => {
  it('neutralises formula-looking text in ordinary columns', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+254 712')).toBe(`"'+254 712"`)
    expect(csvCell('@cmd')).toBe(`"'@cmd"`)
  })

  it('leaves a normal international phone number untouched in the Phone column', () => {
    expect(csvCell('+254 712 345 678', true)).toBe('"+254 712 345 678"')
    expect(csvCell('+1 (415) 555-0100', true)).toBe('"+1 (415) 555-0100"')
  })

  it('still guards a phone cell that is not just digits and separators', () => {
    expect(csvCell('+254 712 345 678 ext=1', true)).toBe(`"'+254 712 345 678 ext=1"`)
    expect(csvCell('=1+1', true)).toBe(`"'=1+1"`)
    expect(csvCell('-5 555 5555', true)).toBe(`"'-5 555 5555"`)
  })

  it('guards a hyphen-only phone, which a spreadsheet would compute as arithmetic', () => {
    expect(csvCell('+1-555-123-4567', true)).toBe(`"'+1-555-123-4567"`)
    expect(csvCell('+44-20-7946-0958', true)).toBe(`"'+44-20-7946-0958"`)
    // spaced / bracketed / dotted forms are not valid formulas and stay untouched
    expect(csvCell('+1 555-123-4567', true)).toBe('"+1 555-123-4567"')
    expect(csvCell('+44.20.7946.0958', true)).toBe('"+44.20.7946.0958"')
  })

  it('the exemption applies only to the Phone column', () => {
    expect(csvCell('+254 712 345 678')).toBe(`"'+254 712 345 678"`)
  })

  it('doubles embedded quotes and tolerates null / numbers', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell(null)).toBe('""')
    expect(csvCell(3)).toBe('"3"')
  })
})
