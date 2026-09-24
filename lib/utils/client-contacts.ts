// lib/utils/client-contacts.ts
//
// FEATURE (deep audit, section 14 — flagship finding): public.client_contacts
// has had a real read/write surface (api/clients/[id]/contacts,
// ClientContactsCard) since a prior fix round — an agency can name "Jane,
// billing contact" and "Priya, primary contact" against a client. But
// nothing anywhere ever consulted that table when actually sending a
// document: sendInvoiceDocument/sendSowDocument/sendCoDocument all send
// exclusively to clients.email + clients.cc_emails. The feature's own
// justifying comment ("invoices go to billing@client.com, scope questions
// go to the PM") described a problem this never actually solved — it was a
// directory, not a routing surface (and the UI was honest about that in its
// own empty-state copy).
//
// `role` on client_contacts is free text with no fixed vocabulary
// ("Billing", "billing contact", "AP", "Accounts Payable" are all
// plausible spellings for the same thing), so matching send-document-type
// to contact-role by string would mean guessing at a taxonomy nobody has
// actually defined — a real risk for something that decides who receives a
// client's financial and legal documents. `is_primary` is the one
// structured, unambiguous signal this schema already has for exactly this
// purpose. So: CC the client's designated primary contact (if any, and if
// distinct from clients.email/cc_emails) on every outbound invoice, SOW,
// and change order — closing the "named people should actually receive
// these" gap without inventing a role taxonomy this data was never given.
// Finer role-based routing (billing vs. scope-question contacts) stays a
// future decision for whoever defines what those roles actually mean.

// FIX (independent pass, section 14 — feature): the note above deferred role-based routing until
// somebody defined a role vocabulary. `client_contacts.role_type` (migration 077) is that structured,
// non-guessable vocabulary — billing | scope | approver | other — chosen from a dropdown, not typed as
// free text. When a caller says what kind of document it is sending, contacts whose role_type fits are
// CC'd too (the free-text `role` label is still never used for routing):
//   invoice → billing contacts;   sow / co → scope + approver contacts.
// The primary contact is always included, exactly as before, and every address is de-duplicated
// against clients.email and cc_emails.
export type ContactDocType = 'invoice' | 'sow' | 'co'
const ROLE_TYPES_FOR: Record<ContactDocType, string[]> = {
  invoice: ['billing'],
  sow:     ['scope', 'approver'],
  co:      ['scope', 'approver'],
}

export async function withPrimaryContactCc(
  service: any,
  clientId: string,
  clientEmail: string | null | undefined,
  existingCc: string[] | null | undefined,
  docType?: ContactDocType,
): Promise<string[]> {
  const cc = existingCc || []
  try {
    if (!clientId) return cc
    const routedTypes = docType ? ROLE_TYPES_FOR[docType] : []
    let q = service.from('client_contacts').select('email, is_primary, role_type').eq('client_id', clientId)
    q = routedTypes.length
      ? q.or(`is_primary.eq.true,role_type.in.(${routedTypes.join(',')})`)
      : q.eq('is_primary', true)
    const { data: rows } = await q

    const seen = new Set([clientEmail, ...cc].map(e => (e || '').toLowerCase().trim()).filter(Boolean))
    const extra: string[] = []
    for (const r of (Array.isArray(rows) ? rows : (rows ? [rows] : []))) {
      const email = String(r?.email || '').trim()
      const key = email.toLowerCase()
      if (!email || seen.has(key)) continue
      seen.add(key)
      extra.push(email)
    }
    return extra.length ? [...cc, ...extra] : cc
  } catch (e) {
    // Never let a lookup failure here block sending the document itself —
    // the client's own email/cc_emails are still the primary delivery
    // path; the contacts are an addition, not a requirement.
    console.error('Contact CC lookup failed:', e)
    return cc
  }
}
