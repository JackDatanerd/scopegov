// app/api/clients/[id]/route.ts
//
// Phase 11: this route did not exist before — clients could be created
// (POST /api/clients) but never edited afterward, at the API layer or
// anywhere else. That meant billing_address and vat_number, which have
// existed as columns since 001_initial_schema.sql, were permanently
// unreachable once a client record was created (and unreachable at
// creation time too, until this same change added them to the POST body).
//
// Reuses CREATE_PROJECTS, same as the POST route — there is no dedicated
// client-edit permission in the schema (see lib/supabase/types.ts) and
// inventing one here would need seeding into every existing role, which
// is out of scope for a billing-fields fix.

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'
import { logAudit } from '@/lib/utils/audit'
import { getClientIp } from '@/lib/utils/request-ip'
import { parseClientInput } from '@/lib/utils/client-input'
import { isUuidString } from '@/lib/utils/uuid'

// Free-text fields whose VALUE is not copied into the audit trail (only "changed").
const AUDIT_REDACT = new Set(['notes'])

// FIX (independent pass 17, section 14 — B2): the before/after comparison below used JSON.stringify, which is key-ORDER
// sensitive. billing_address comes back from jsonb in jsonb's key order (shorter keys first) while the parser writes it in
// line1, line2, city, … order, so a save that changed nothing but whitespace (trimmed server-side) was audited as a
// `client.updated` whose "from" and "to" were identical. Compared with object keys sorted instead.
function stableJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm)
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, val]) => [k, norm(val)]))
    }
    return x ?? null
  }
  return JSON.stringify(norm(v))
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id }  = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'CREATE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    // FIX (independent pass 1, section 14 — B3): a non-UUID id used to reach Postgres (22P02) and surface as a 500.
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const service = createServiceClient()

    // A read failure must surface as a 500, not masquerade as "not found" (maybeSingle: no row → null, no error).
    const { data: existing, error: existingErr } = await (service as any)
      .from('clients').select('*')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (existingErr) throw new Error(existingErr.message)
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    let body: any
    try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    // (audit round 6) Contact-visibility fields require VIEW_CLIENT_DATA as well — a role that can't SEE
    // a client's email must not be able to blindly overwrite the address every invoice/SOW/CO goes to.
    // (clients pass 8) `timezone` is displayed only inside the VIEW_CLIENT_DATA-gated Contact card and drives when this
    // client's invoice reminders fire, so it is gated the same way.
    const contactFields = ['email', 'phone', 'notes', 'paymentTermsNote', 'ccEmails', 'timezone']
    if (contactFields.some(f => body[f] !== undefined) && !hasPermission(session, 'VIEW_CLIENT_DATA')) {
      return NextResponse.json({ error: 'Missing permission: VIEW_CLIENT_DATA' }, { status: 403 })
    }

    // Shared, type-checked parser (see lib/utils/client-input.ts) — replaces the per-route field
    // handling that let non-strings 500, blanked NOT NULL columns and stored arbitrary JSON.
    const parsed = parseClientInput(body, 'update', { currentEmail: existing.email, currentBillingAddress: existing.billing_address })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const updates: Record<string, unknown> = { ...parsed.updates, updated_at: new Date().toISOString() }

    // status (active/archived)
    if (body.status !== undefined) {
      if (!['active', 'archived'].includes(body.status))
        return NextResponse.json({ error: 'status must be "active" or "archived"' }, { status: 400 })
      updates.status = body.status
    }

    // FIX (independent pass 17, section 14 — B2): a body that carried nothing this route writes (`{}`, or only unknown keys)
    // still ran the RPC and bumped updated_at. Nothing to save → nothing written.
    if (!Object.keys(updates).some(k => k !== 'updated_at'))
      return NextResponse.json({ ok: true, unchanged: true })

    // Email changes go through the same duplicate check as creation (case-insensitive).
    const emailChanged = typeof updates.email === 'string' && updates.email !== String(existing.email || '').toLowerCase()
    if (emailChanged) {
      // The new primary must not also sit in the CC list, and a corrected address gets a clean
      // delivery-health slate (the bounce marker belonged to the OLD address).
      if (updates.cc_emails === undefined && Array.isArray(existing.cc_emails)) {
        const filtered = existing.cc_emails.filter((e: string) => String(e).toLowerCase() !== updates.email)
        if (filtered.length !== existing.cc_emails.length) updates.cc_emails = filtered
      }
      updates.email_bounced_at = null
      updates.email_bounce_kind = null
    }

    // FIX (independent pass, section 14 re-audit — flagship finding): this used to be a plain
    // select-then-update — an `ilike` pre-check for a duplicate email, then a SEPARATE `.update()`
    // call. That's the exact TOCTOU shape migration 088's own comment identifies and closes for
    // client CREATION via an advisory-locked RPC (create_client) — a fix that was never extended to
    // this edit path, which writes the same column under the same invariant. For any workspace
    // where clients_workspace_email_lower (077) doesn't exist (one that had a case-variant
    // duplicate email when 077 ran and was never cleaned up), two concurrent edits changing two
    // different clients' emails to case-variants of the same address could both pass this route's
    // own pre-check and both commit — silently reintroducing the exact duplicate condition the
    // whole 077→088 lineage exists to prevent. update_client_checked (108) does the duplicate check
    // AND the write inside one transaction, under the same advisory lock create_client already uses.
    const { data: result, error } = await (service as any).rpc('update_client_checked', {
      p_client_id: id, p_workspace_id: session.workspaceId, p_patch: updates,
    })
    // Belt-and-braces: the DB's own UNIQUE constraint still exists as a last resort (e.g. a schema
    // rollback that predates 108) — surface it the same clean way as the RPC's own dup result.
    if (error?.code === '23505')
      return NextResponse.json({ error: 'A client with this email already exists' }, { status: 409 })
    if (error) throw new Error(error.message)
    if (!result?.ok)
      return NextResponse.json({ error: 'A client with this email already exists', existingClientId: result?.existing_id }, { status: 409 })
    // The client can be deleted or merged away between the read above and the RPC; the RPC then matches no row
    // and reports updated:false. That is a 404 — not a success, and nothing to audit.
    if (result.updated === false) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // FIX (independent pass, section 14): the audit row recorded only Object.keys(body) — which
    // fields were SENT, not what changed (and it listed a field as updated even when the route
    // ignored it). A change to the email / CC list / billing address redirects where every invoice
    // goes, and nothing recorded the old value. Now: real before → after for what changed.
    const changes: Record<string, { from?: unknown; to?: unknown; changed?: true }> = {}
    for (const [col, next] of Object.entries(updates)) {
      if (col === 'updated_at' || col === 'email_bounced_at' || col === 'email_bounce_kind') continue
      const prev = existing[col]
      if (stableJson(prev) === stableJson(next)) continue
      changes[col] = AUDIT_REDACT.has(col) ? { changed: true } : { from: prev ?? null, to: next ?? null }
    }
    // FIX (independent pass 12, section 14 — B2): archiving / reactivating a client is its own decision (it hides the client
    // from the default roster), but it was recorded as a generic `client.updated` — the client's activity list read
    // "Details updated — status". A change that is ONLY the status now gets its own event; a save that changes status
    // together with other fields stays `client.updated` (its `fields` / `changes` still name the status).
    const onlyStatus = Object.keys(changes).length === 1 && 'status' in changes
    const eventType = onlyStatus ? (changes.status.to === 'archived' ? 'client.archived' : 'client.unarchived') : 'client.updated'
    if (Object.keys(changes).length > 0) {
      await logAudit(service, {
        workspaceId: session.workspaceId, actorId: session.id,
        actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
        eventType, entityType: 'client',
        entityId: id, entityName: (updates.name as string) || existing.name,
        metadata: { fields: Object.keys(changes), changes },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Client update error:', err)
    return NextResponse.json({ error: 'Could not update the client' }, { status: 500 })
  }
}

// FEATURE (independent pass, section 14): a client created by mistake (a typo, a duplicate) could
// never be removed — only archived, and it stayed on the roster forever. A client with NO projects
// can now be deleted outright. projects.client_id has no cascade, so a client that has (or ever had,
// including soft-deleted) projects is refused — archive or merge it instead.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'DELETE_PROJECTS'))
      return NextResponse.json({ error: 'Missing permission: DELETE_PROJECTS' }, { status: 403 })
    // FIX (independent pass 1, section 14 — B3): a non-UUID id used to reach Postgres (22P02) and surface as a 500.
    if (!isUuidString(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const service = createServiceClient()
    const { data: client, error: clientErr } = await (service as any)
      .from('clients').select('id, name, email, company_name')
      .eq('id', id).eq('workspace_id', session.workspaceId).maybeSingle()
    if (clientErr) throw new Error(clientErr.message)
    if (!client) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { count: projectCount, error: countErr } = await (service as any)
      .from('projects').select('id', { count: 'exact', head: true })
      .eq('workspace_id', session.workspaceId).eq('client_id', id)
    if (countErr) throw new Error(countErr.message)
    if ((projectCount || 0) > 0) {
      // The true count includes projects (and deleted ones) this member may not be allowed to see, and
      // "merge instead" is only open to members with VIEW_ALL_PROJECTS — so those members get no number
      // and no merge suggestion.
      if (!hasPermission(session, 'VIEW_ALL_PROJECTS'))
        return NextResponse.json({ error: `${client.name} still has projects on record, so it can't be deleted. Archive it instead.` }, { status: 409 })
      return NextResponse.json({
        error: `${client.name} has ${projectCount} project${projectCount === 1 ? '' : 's'} on record (including deleted ones), so it can't be deleted. Archive it, or merge it into another client.`,
      }, { status: 409 })
    }

    const { error } = await (service as any).from('clients').delete().eq('id', id).eq('workspace_id', session.workspaceId)
    if (error?.code === '23503')
      return NextResponse.json({ error: 'This client is still referenced by other records and can’t be deleted. Archive it instead.' }, { status: 409 })
    if (error) throw new Error(error.message)

    await logAudit(service, {
      workspaceId: session.workspaceId, actorId: session.id,
      actorEmail: session.email, actorName: session.name, ipAddress: getClientIp(request),
      eventType: 'client.deleted', entityType: 'client',
      entityId: id, entityName: client.name,
      metadata: { email: client.email, company_name: client.company_name },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Client delete error:', err)
    return NextResponse.json({ error: 'Could not delete the client' }, { status: 500 })
  }
}
