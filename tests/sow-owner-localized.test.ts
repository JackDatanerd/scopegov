import { describe, it, expect } from 'vitest'
import { normalizeEnumCell } from '@/lib/ai/sow-content'

const OWNER = ['Provider', 'Client', 'Joint']

describe('normalizeEnumCell — localized Owner values (SOW lifecycle pass 19, B1)', () => {
  it.each([
    ['Proveedor', 'Provider'], ['Prestataire', 'Provider'], ['Fournisseur', 'Provider'], ['Prestador', 'Provider'],
    ['Auftragnehmer', 'Provider'], ['Mtoa huduma', 'Provider'], ['Agência', 'Provider'], ['Proveedor (equipo de diseño)', 'Provider'],
    ['Cliente', 'Client'], ['Kunde', 'Client'], ['Mteja', 'Client'], ['Auftraggeber', 'Client'],
    ['Ambos', 'Joint'], ['Les deux', 'Joint'], ['Gemeinsam', 'Joint'], ['Pamoja', 'Joint'], ['Compartilhado', 'Joint'],
    ['Provider', 'Provider'], ['agency', 'Provider'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeEnumCell(input, OWNER)).toBe(expected)
  })
  it('unknown still falls back to the last option', () => {
    expect(normalizeEnumCell('zzz', OWNER)).toBe('Joint')
  })
})
