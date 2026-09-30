import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { redactClientDataRow, redactMetadata, isClientDataKey, REDACTED } from '@/lib/audit/redact'
import { buildAuditSearchFilter } from '@/lib/audit/search'
import { effectiveContractValue, monthlyRetainerRate } from '@/lib/utils/contract-value'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ── B1: client contact data must not leak through the audit log ────────────────────────────────
describe('redactClientDataRow (B1)', () => {
  const updated = {
    event_type: 'client.updated', entity_name: 'Acme Ltd',
    metadata: {
      fields: ['email', 'phone'],
      changes: { email: { from: 'old@acme.com', to: 'new@acme.com' }, phone: { from: '1', to: '2' } },
    },
  }
  it('leaves the row untouched for a viewer who holds VIEW_CLIENT_DATA', () => {
    expect(redactClientDataRow(updated, true)).toBe(updated)
  })
  it('keeps structural keys but replaces before/after values on client.updated', () => {
    const out = redactClientDataRow(updated, false)
    expect(out.metadata.fields).toEqual(['email', 'phone'])
    expect(out.metadata.changes).toBe(REDACTED)
    expect(JSON.stringify(out)).not.toContain('acme.com')
    expect(out.entity_name).toBe('Acme Ltd') // the client's own name is shown on the Clients list to everyone
  })
  it('strips the deleted client\'s email but keeps its company name', () => {
    const out = redactClientDataRow({
      event_type: 'client.deleted', entity_name: 'Acme Ltd',
      metadata: { email: 'x@acme.com', company_name: 'Acme Holdings' },
    }, false)
    expect(out.metadata).toEqual({ email: REDACTED, company_name: 'Acme Holdings' })
  })
  it('strips the merged-away client\'s email at depth, keeps ids, names and counters', () => {
    const out = redactClientDataRow({
      event_type: 'client.merged', entity_name: 'Target',
      metadata: { merged_from: { id: 'u1', name: 'Source', email: 's@x.com' }, projects_moved: 3, contacts_moved: 1, fields: ['phone'] },
    }, false)
    expect(out.metadata.merged_from).toEqual({ id: 'u1', name: 'Source', email: REDACTED })
    expect(out.metadata.projects_moved).toBe(3)
    expect(out.metadata.fields).toEqual(['phone'])
  })
  it('withholds a contact\'s name (entity), email and job title on client_contact.* rows', () => {
    const out = redactClientDataRow({
      event_type: 'client_contact.created', entity_name: 'Jane Doe (Acme Ltd)',
      metadata: { client_id: 'c1', email: 'jane@acme.com', role: 'CFO', role_type: 'billing', is_primary: true },
    }, false)
    expect(out.entity_name).toBe(REDACTED)
    expect(out.metadata).toEqual({ client_id: 'c1', email: REDACTED, role: REDACTED, role_type: 'billing', is_primary: true })
  })
  it('fails closed: an unknown key on a client event is redacted, not passed through', () => {
    const out = redactClientDataRow({ event_type: 'client.updated', entity_name: 'A', metadata: { brand_new_field: 'secret@x.com' } }, false)
    expect(out.metadata.brand_new_field).toBe(REDACTED)
  })
  it('redacts client_email / guardian_email on other events (reminders, SOW signing) without touching the rest', () => {
    const out = redactClientDataRow({
      event_type: 'reminder.sent', entity_name: 'Invoice 7',
      metadata: { type: 'invoice', client_email: 'c@x.com', nested: { guardian_email: 'g@x.com', keep: 1 } },
    }, false)
    expect(out.metadata).toEqual({ type: 'invoice', client_email: REDACTED, nested: { guardian_email: REDACTED, keep: 1 } })
    expect(out.entity_name).toBe('Invoice 7')
  })
  it('tolerates null metadata and null entity names', () => {
    expect(redactClientDataRow({ event_type: 'client_contact.deleted', entity_name: null, metadata: null }, false).entity_name).toBe(null)
    expect(redactClientDataRow({ event_type: 'client.created', entity_name: 'A', metadata: {} }, false).metadata).toEqual({})
  })
  it('recognises the key spellings the codebase uses', () => {
    for (const k of ['email', 'client_email', 'clientEmail', 'guardian_email', 'cc_emails', 'ccEmails', 'phone', 'vat_number', 'billing_address', 'payment_terms_note'])
      expect(isClientDataKey(k)).toBe(true)
    for (const k of ['actor_email_sent', 'emailSent', 'email_delivered', 'client_id', 'fields'])
      expect(isClientDataKey(k)).toBe(false)
  })
  it('the money redaction still leaves client_email alone when called on its own (existing contract)', () => {
    expect(redactMetadata({ client_email: 'x@y.z' }, false)!.client_email).toBe('x@y.z')
  })
})

describe('audit search does not confirm hidden contact names (B1)', () => {
  it('default filter is unchanged', () => {
    expect(buildAuditSearchFilter('jane')).toContain('entity_name.ilike."%jane%"')
    expect(buildAuditSearchFilter('jane')).not.toContain('and(')
  })
  it('for a viewer without VIEW_CLIENT_DATA the entity_name clause skips client_contact rows', () => {
    const f = buildAuditSearchFilter('jane', { hideContactNames: true })!
    expect(f).toContain('and(entity_type.neq.client_contact,entity_name.ilike."%jane%")')
    expect(f).toContain('actor_name.ilike."%jane%"')
  })
})

describe('audit-export applies the client-data rule once, before any format (B1)', () => {
  const src = read('app/api/reports/audit-export/route.ts')
  it('gates on VIEW_CLIENT_DATA and redacts rows ahead of the json / csv / pdf branches', () => {
    expect(src).toContain("hasPermission(session, 'VIEW_CLIENT_DATA')")
    expect(src.indexOf('redactClientDataRow(r, canViewClientData)')).toBeGreaterThan(0)
    expect(src.indexOf('redactClientDataRow(r, canViewClientData)')).toBeLessThan(src.indexOf("if (format === 'json') {\n      return"))
    expect(src).toContain('hideContactNames: !canViewClientData')
  })
})

// ── B2: one definition of a project's value on the Clients screens ─────────────────────────────
describe('client screens use the shared project value (B2)', () => {
  it('a 12-month retainer at 2,000/mo is worth 24,000, with a 2,000 monthly rate', () => {
    const p = { id: 'p', type: 'retainer', contract_value: 2000, retainer_duration_months: 12 }
    expect(effectiveContractValue(p, [])).toBe(24000)
    expect(monthlyRetainerRate(p)).toBe(2000)
  })
  it('the list page loads type, term and amendments and hands effective_value to the client component', () => {
    const page = read('app/(app)/clients/page.tsx')
    expect(page).toContain('retainer_duration_months')
    expect(page).toContain('amendments(financial_impact, change_orders(is_retainer_renewal))')
    expect(page).toContain('effectiveContractValue(p, amendments')
    expect(page).toContain('effective_value: null')
    const client = read('components/clients/ClientsClient.tsx')
    expect(client).toContain('contract_value: p.effective_value')
  })
  it('the detail page totals and per-row value use effective_value, with a /mo line for retainers', () => {
    const page = read('app/(app)/clients/[id]/page.tsx')
    expect(page).toContain('contract_value: p.effective_value')
    expect(page).toContain('p.effective_value ? formatCurrency(p.effective_value')
    expect(page).toContain('/mo</div>')
    expect(page).not.toContain('p.contract_value ? formatCurrency(p.contract_value')
  })
  it('a viewer without VIEW_FINANCIALS gets no value fields at all', () => {
    const page = read('app/(app)/clients/[id]/page.tsx')
    expect(page).toContain('contract_value: null, effective_value: null, monthly_rate: null')
  })
})

// ── B3: a failed save always says something readable ────────────────────────────────────────────
describe('client components never throw the JSON parser\'s message or an empty one (B3)', () => {
  const files = [
    'components/clients/ClientsClient.tsx', 'components/clients/ClientContactCard.tsx',
    'components/clients/BillingDetailsCard.tsx', 'components/clients/ClientContactsCard.tsx',
  ]
  for (const f of files) {
    it(`${path.basename(f)}: every res.json() is guarded and every thrown error has a fallback`, () => {
      const src = read(f)
      const bare = src.split('\n').filter(l => /await res\.json\(\)/.test(l) && !/\.catch\(/.test(l))
      expect(bare).toEqual([])
      const emptyThrows = src.split('\n').filter(l => /throw new Error\(json\.error\)/.test(l))
      expect(emptyThrows).toEqual([])
    })
  }
})
