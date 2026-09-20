export const runtime = 'nodejs'

import { markFirstViewed } from '@/lib/utils/client-viewed'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { formatAddress } from '@/lib/utils/format'
import { getWorkspaceJwtSecret, isWorkspaceDeleted } from '@/lib/utils/workspace-secret'

const CO_COLUMNS = `id,title,note,status,version,line_items,subtotal,tax_rate,tax_inclusive,
  total,expires_at,flag_id,workspace_id,accepted_by,accepted_at,client_signature_data,first_viewed_at,
  projects(id,name,currency,clients(name,email,cc_emails,company_name,billing_address,vat_number),
    workspaces(id,agency_name,brand_colour,logo_storage_path,agency_signature_data,
      legal_address,tax_id,phone,website))`

async function getCoByToken(token: string, service: any, userAgent: string | null = null) {
  const { data: revoked } = await (service as any)
    .from('revoked_tokens').select('reason, document_id').eq('token', token).single()

  // FIX (re-audit, critical finding): this used to map ANY non-'declined'
  // revoked reason — including 'superseded', which accept/route.ts and
  // countersign/route.ts both insert the instant a client successfully
  // accepts — straight to a generic 'revoked' state, before ever reaching
  // the co.status === 'accepted' branch below (which already returns
  // acceptedBy/clientSignatureData, clearly built for exactly this
  // revisit case, but was unreachable). A client who accepted a CO, then
  // later re-clicked the *original* email link (still sitting in their
  // inbox — the confirmation email was patched to link elsewhere, but the
  // original send-out email never was), saw "This link is no longer
  // active" instead of their own accepted document.
  //
  // 'declined' never touches change_orders.token, so the CO is still
  // resolvable by token below — let co.status (which already handles
  // every terminal state correctly, including 'accepted') drive the
  // response instead of guessing from the revocation reason. Only
  // 'withdrawn' (api/co/[id]/withdraw) actually nulls the token, making
  // the CO unresolvable by token afterward — that's the one reason that
  // must be trusted directly, and it now maps to the dedicated 'withdrawn'
  // state the frontend already supports, instead of generic 'revoked'.
  if (revoked && revoked.reason === 'withdrawn') return { state: 'withdrawn' }

  // FIX (build, cron/portal audit round — see migration 051): co-expiry
  // now inserts a revoked_tokens row (reason: 'expired') alongside nulling
  // change_orders.token, the same way 'withdrawn' already does — same
  // reasoning as the withdrawn check just above: the token is genuinely
  // gone from the row, so co-by-token lookup below would never resolve
  // it, and this must be trusted directly rather than falling through to
  // the generic `revoked ? 'revoked' : 'invalid'` at the bottom of this
  // function (which is what happened before this reason existed — see
  // that line's own comment for the pre-cron-catch-up case this doesn't
  // replace, just complements).
  if (revoked && revoked.reason === 'expired') return { state: 'expired' }

  // FIX (doc-completeness audit): same gap as the SOW portal route — legal
  // and billing fields were never selected here, so the client accepted a
  // CO without ever seeing the agency/client addresses or tax IDs that
  // appear on the CO PDF.
  let { data: co } = await (service as any)
    .from('change_orders').select(CO_COLUMNS).eq('token', token).single()

  // FIX (portal audit, section 18 — flagship finding): the "critical
  // finding" comment above turned out to rest on a false premise —
  // accept/route.ts and countersign/route.ts BOTH rotate
  // change_orders.token to a fresh value the instant a client completes
  // one of those actions (see finalize-co.ts), specifically so the
  // long-term access link can outlive the short signing-window expiry.
  // That means the ORIGINAL token — the one actually sitting in the
  // client's very first "please review" email — stops matching this row
  // at all, and the "co.status already handles every terminal state"
  // reasoning above never gets a chance to run, because `co` comes back
  // null before it does. This is the exact revisit-the-original-email
  // scenario the comment above describes, still broken by a second
  // mechanism it didn't account for. document_id (migration 029) lets a
  // 'superseded'-revoked token resolve to the live row by id instead. No
  // separate JWT check is needed for this path: an exact match against
  // revoked_tokens.token — a random signed value nobody could have
  // without having received the original email — is equivalent proof of
  // possession to matching change_orders.token directly.
  let skipJwtVerify = false
  if (!co && revoked?.reason === 'superseded' && revoked.document_id) {
    const { data: byId } = await (service as any)
      .from('change_orders').select(CO_COLUMNS).eq('id', revoked.document_id).single()
    if (byId) { co = byId; skipJwtVerify = true }
  }

  if (!co) return { state: revoked ? 'revoked' : 'invalid' }

  // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — flagship
  // finding): see isWorkspaceDeleted's own comment in workspace-secret.ts.
  // Reuses the 'revoked' UI bucket, same as the SOW portal route.
  if (await isWorkspaceDeleted(service, co.workspace_id)) return { state: 'revoked' }

  if (!skipJwtVerify) {
    // jwt_secret lives in workspace_secrets now, not on workspaces itself —
    // see migration 013.
    try {
      const jwtSecret = await getWorkspaceJwtSecret(service, co.workspace_id)
      if (!jwtSecret) throw new Error('no secret')
      const secret = new TextEncoder().encode(jwtSecret)
      await jwtVerify(token, secret)
    } catch {
      if (co.expires_at && new Date(co.expires_at) < new Date()) return { state: 'expired' }
      return { state: 'invalid' }
    }
  }

  // BUG: 'closed', 'stalled', and 'countered' were never included here, so
  // revisiting the link for a CO in any of those states fell through to the
  // default case below and re-served the full accept/decline/counter form.
  if (co.status === 'accepted') {
    return { state: 'accepted', acceptedBy: co.accepted_by, clientSignatureData: co.client_signature_data || null }
  }
  // 'stalled' deliberately falls through: it is an agency-side attention flag (no reply for 5 days), the
  // offer is still live until it expires, and the client must still be able to answer it.
  if (['declined','withdrawn','closed','countered'].includes(co.status)) return { state: co.status }

  // FEATURE (portal audit, section 18): first time this document is
  // actually opened while still awaiting a client response — mirrors the
  // identical fix in the SOW portal route. Must never block the response
  // below if the write fails.
  if (!co.first_viewed_at) {
    await markFirstViewed(service, {
      kind: 'co', id: co.id, workspaceId: co.workspace_id, projectId: co.projects?.id,
      projectName: co.projects?.name || '', clientName: co.projects?.clients?.name || '',
      userAgent,
    })
  }

  // FIX (doc-completeness audit, migration 014): a CO the agency has
  // accepted at the client's counter amount now needs the client to
  // countersign before it's final — distinct from the original
  // accept/counter/decline form, which no longer applies here.
  return { co, mode: co.status === 'awaiting_countersignature' ? 'countersign' : 'respond' }
}

// GET — return CO data for portal
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service   = createServiceClient()
    const result    = await getCoByToken(token, service, request.headers.get('user-agent'))

    if (result.state) return NextResponse.json({
      state: result.state,
      acceptedBy: (result as any).acceptedBy,
      clientSignatureData: (result as any).clientSignatureData,
    })

    const co  = result.co!
    const mode = (result as any).mode || 'respond'
    const ws  = co.projects?.workspaces
    let logoUrl: string | null = null
    if (ws?.logo_storage_path) {
      const { data: u } = await (service as any).storage.from('logos').getPublicUrl(ws.logo_storage_path)
      logoUrl = u?.publicUrl || null
    }

    const lineItems = typeof co.line_items === 'string' ? JSON.parse(co.line_items) : (co.line_items || [])

    return NextResponse.json({
      co: {
        id:          co.id,
        title:       co.title,
        note:        co.note,
        mode,
        projectName: co.projects?.name,
        agencyName:  ws?.agency_name,
        brandColour: ws?.brand_colour || '#1A5C3A',
        logoUrl,
        // FIX (bug — React error #31, same root cause as the SOW portal
        // route): legal_address/billing_address are jsonb objects, not
        // strings — format before sending to the client.
        agencyAddress: formatAddress(ws?.legal_address) || null,
        agencyTaxId:   ws?.tax_id || null,
        agencyPhone:   ws?.phone || null,
        agencyWebsite: ws?.website || null,
        agencySignatureData: ws?.agency_signature_data || null,
        lineItems,
        subtotal:    co.subtotal,
        taxRate:     co.tax_rate,
        taxInclusive: co.tax_inclusive,
        total:       co.total,
        currency:    co.projects?.currency || 'USD',
        clientName:  co.projects?.clients?.name || '',
        clientCompany: co.projects?.clients?.company_name || null,
        clientBillingAddress: formatAddress(co.projects?.clients?.billing_address) || null,
        clientVatNumber:      co.projects?.clients?.vat_number || null,
        version:     co.version,
        expiresAt:   co.expires_at,
      },
    })
  } catch (err) {
    return NextResponse.json({ state: 'invalid' })
  }
}
