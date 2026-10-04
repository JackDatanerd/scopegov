import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTableAmount as p } from '@/lib/sow/table-schema'
import { validateSowForSend } from '@/lib/sow/validate-send'
import {
  structureForProject, paymentStructureError, effectiveFormStructure, storedPaymentStructure,
} from '@/lib/sow/payment-structure'

// SOW lifecycle, independent pass 11.
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

const baseSections = [
  { id: 'parties', content: '<p>x</p>', visible: true },
  { id: 'deliverables', table: [{ deliverable: 'A' }], visible: true },
  { id: 'oos', content: '<p>None</p>', visible: true },
  { id: 'payment', content: '<p>USD 1,000 monthly</p>', visible: true },
  { id: 'governing_law', content: '<p>Kenya</p>', visible: true },
  { id: 'signature', content: '<p>s</p>', visible: true },
]
const validate = (metadata: any, projectType?: string | null) =>
  validateSowForSend({ sections: baseSections, metadata, contractValue: 1000, projectType })

describe('B1 — payment structure must agree with how the project is billed', () => {
  it('a retainer is always generated as monthly; others keep what was asked', () => {
    expect(structureForProject('retainer', '50_50')).toBe('monthly')
    expect(structureForProject('retainer', 'milestones')).toBe('monthly')
    expect(structureForProject('web', '50_50')).toBe('50_50')
  })
  it('refuses monthly on a one-off project, and anything but monthly on a retainer', () => {
    expect(paymentStructureError('web', 'monthly')).toMatch(/only available for retainer/)
    expect(paymentStructureError('retainer', '50_50')).toMatch(/billed monthly/)
    expect(paymentStructureError('retainer', 'milestones')).not.toBeNull()
    expect(paymentStructureError('retainer', 'monthly')).toBeNull()
    expect(paymentStructureError('web', '50_50')).toBeNull()
  })
  it('a missing stored structure counts as 50/50, like createSowMilestones', () => {
    expect(storedPaymentStructure({})).toBe('50_50')
    expect(storedPaymentStructure(null)).toBe('50_50')
    expect(storedPaymentStructure({ paymentStructure: 'monthly' })).toBe('monthly')
  })
  it('the form shows monthly only for a retainer', () => {
    expect(effectiveFormStructure('retainer', '50_50')).toBe('monthly')
    expect(effectiveFormStructure('web', 'monthly')).toBe('50_50')
    expect(effectiveFormStructure('web', 'milestones')).toBe('milestones')
  })
  it('send validation blocks a mismatched SOW and passes a matching one', () => {
    expect(validate({ paymentStructure: '50_50' }, 'retainer').errors.join(' ')).toMatch(/retainer/)
    expect(validate({}, 'retainer').errors.length).toBeGreaterThan(0)
    expect(validate({ paymentStructure: 'monthly' }, 'retainer').errors).toEqual([])
    expect(validate({ paymentStructure: 'monthly' }, 'web').errors.join(' ')).toMatch(/only available for retainer/)
    expect(validate({ paymentStructure: '50_50' }, 'web').errors).toEqual([])
  })
  it('callers that cannot know the project type skip only that check', () => {
    expect(validate({ paymentStructure: 'monthly' }, undefined).errors).toEqual([])
  })
  it('wiring: send route, auto-send, generate, signing and the repair sweep all use the project type', () => {
    expect(read('app/api/sow/[id]/send/route.ts')).toMatch(/projectType:\s*project\.type/)
    expect(read('lib/documents/send-sow.ts')).toMatch(/projectType:\s*project\.type/)
    const gen = read('app/api/sow/generate/route.ts')
    expect(gen).toMatch(/structureForProject\(project\.type, requestedStructure\)/)
    expect(gen).toMatch(/paymentStructureError\(project\.type, paymentStructure\)/)
    expect(read('app/api/portal/sow/[token]/sign/route.ts')).toMatch(/undefined, project\.type\)/)
    const integrity = read('lib/documents/signing-integrity.ts')
    expect(integrity).toMatch(/currency, type, guardian_email/)
    expect(integrity).toMatch(/project\.type,\n\s*\)/)
  })
  it('signing creates only the monthly row for a retainer, whatever structure the SOW carries', () => {
    expect(read('lib/documents/post-signing.ts')).toMatch(/projectType === 'retainer' \? 'monthly' : \(metadata\?\.paymentStructure \|\| '50_50'\)/)
  })
})

describe('B2 — a long integer followed by a 3-digit fraction is not a thousands group', () => {
  it('reads 2500.567 as a decimal, never 2,500,567', () => {
    expect(p('2500.567')).toBe(2500.567)
    expect(p('12345,678')).toBe(12345.678)
  })
  it('still reads genuine thousands groups', () => {
    expect(p('1,500')).toBe(1500)
    expect(p('1.500')).toBe(1500)
    expect(p('999,999')).toBe(999999)
    expect(p('1,234,567')).toBe(1234567)
    expect(p('1,00,000')).toBe(100000)
    expect(p('0.500')).toBe(0.5)
  })
  it('reports a fraction longer than three digits as unreadable', () => {
    expect(p('1,2345')).toBeNull()
    expect(p('7.12345')).toBeNull()
  })
  it('leaves one/two-digit decimals alone', () => {
    expect(p('1,5')).toBe(1.5)
    expect(p('12,34')).toBe(12.34)
    expect(p('2500.50')).toBe(2500.5)
  })
})

describe('B4 — metadata keys are merged atomically', () => {
  it('migration 145 merges one key under the draft guard', () => {
    const sql = read('supabase/migrations/145_sow_set_metadata_key.sql')
    expect(sql).toMatch(/sow_set_metadata_key/)
    expect(sql).toMatch(/\|\| jsonb_build_object\(p_key/)
    expect(sql).toMatch(/status = 'draft'/)
    expect(sql).toMatch(/sent_at IS NULL/)
    expect(sql).toMatch(/GRANT EXECUTE[\s\S]*service_role/)
  })
  it('PATCH msaReference and request-changes use it, keeping a fallback for an uninstalled function', () => {
    const patch = read('app/api/sow/[id]/route.ts')
    expect(patch).toMatch(/rpc\('sow_set_metadata_key', \{ p_sow_id: id, p_key: 'msaReference'/)
    expect(patch).toMatch(/guardedUpdate\(\{ metadata:/)
    const rc = read('app/api/portal/sow/[token]/request-changes/route.ts')
    expect(rc).toMatch(/rpc\('sow_set_metadata_key', \{ p_sow_id: openDraft\.id, p_key: 'changeRequest'/)
    expect(rc).toMatch(/\.eq\('id', openDraft\.id\)\.eq\('status', 'draft'\)/)
  })
})
