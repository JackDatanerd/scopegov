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

export async function withPrimaryContactCc(
  service: any,
  clientId: string,
  clientEmail: string | null | undefined,
  existingCc: string[] | null | undefined
): Promise<string[]> {
  const cc = existingCc || []
  try {
    const { data: primary } = await service
      .from('client_contacts')
      .select('email')
      .eq('client_id', clientId)
      .eq('is_primary', true)
      .maybeSingle()

    if (!primary?.email) return cc

    const primaryEmail = String(primary.email).toLowerCase().trim()
    const alreadyIncluded = [clientEmail, ...cc].some(
      e => (e || '').toLowerCase().trim() === primaryEmail
    )
    return alreadyIncluded ? cc : [...cc, primary.email]
  } catch (e) {
    // Never let a lookup failure here block sending the document itself —
    // the client's own email/cc_emails are still the primary delivery
    // path; the primary contact is an addition, not a requirement.
    console.error('Primary contact CC lookup failed:', e)
    return cc
  }
}
