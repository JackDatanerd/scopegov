export const runtime = 'nodejs'

import { markFirstViewed } from '@/lib/utils/client-viewed'
import { hydrateSections } from '@/lib/sow/sections'
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { formatAddress } from '@/lib/utils/format'
import { checkRevokedToken, verifySowJwt } from './_shared'
import { isWorkspaceDeleted } from '@/lib/utils/workspace-secret'

const SOW_COLUMNS = `id, version, status, sections, metadata, expires_at, signed_at, signed_by, client_signature_data, first_viewed_at,
  projects(id, name, disc, contract_value, currency, client_id,
    clients(name, email, company_name, billing_address, vat_number),
    workspaces(id, agency_name, brand_colour, logo_storage_path, agency_signature_data,
      legal_address, tax_id, phone, website))`

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service   = createServiceClient()

    // Check revoked tokens first
    const { revoked, reason: revokedReason, documentId } = await checkRevokedToken(service, token)

    if (revoked) {
      // FIX (portal audit, section 18 — flagship finding): a 'superseded'
      // reason means this is the client's ORIGINAL signing-link token,
      // superseded by the fresh one minted at signature time (see the
      // sign route's step 1b) — not actually dead, just rotated. Without
      // this, revisiting the very first "please sign" email after having
      // already signed showed a generic "no longer active" page instead
      // of the executed document. document_id (migration 029) resolves
      // it back to the live row so the normal status branching below can
      // run, exactly as if the current token had been used.
      if (revokedReason === 'superseded' && documentId) {
        const { data: sow } = await (service as any)
          .from('sow_documents').select(SOW_COLUMNS).eq('id', documentId).single()
        if (sow) return NextResponse.json(await buildSowResponse(sow, service, request.headers.get('user-agent')))
      }
      return NextResponse.json({
        state: revokedReason === 'declined' ? 'declined'
          : revokedReason === 'withdrawn' ? 'withdrawn'
          // FIX (build, cron/portal audit round — see migration 051):
          // sow-expiry now inserts a revoked_tokens row (reason: 'expired')
          // alongside nulling sow_documents.token, closing the gap where
          // an expired link — once the daily cron had caught up — fell
          // through to the generic 'revoked' bucket instead of the
          // purpose-built 'expired' one below (line ~96 already handles
          // this correctly for the pre-cron window; this is the same
          // outcome for after the cron has run).
          : revokedReason === 'expired' ? 'expired'
          : 'revoked',
      })
    }

    // Find SOW by token
    // FIX (doc-completeness audit): this query never selected legal/billing
    // fields (agency legal_address/tax_id/phone/website, client
    // billing_address/vat_number), so the page a client actually reviews
    // and signs on was missing details that only showed up later on the
    // PDF generated after signing. Select them so the pre-signature view
    // matches the document of record.
    const { data: sow } = await (service as any)
      .from('sow_documents').select(SOW_COLUMNS).eq('token', token).single()

    if (!sow) return NextResponse.json({ state: 'invalid' })

    // FIX (deep audit, Workspace lifecycle + Onboarding re-pass — flagship
    // finding): see isWorkspaceDeleted's own comment in workspace-secret.ts.
    // Reuses the 'revoked' UI bucket rather than a new state — the message
    // ("no longer active, contact the agency") is accurate either way and
    // doesn't need to spell out to the client that the workspace was
    // specifically deleted.
    const workspaceIdForDeleteCheck = sow.projects?.workspaces?.id
    if (workspaceIdForDeleteCheck && await isWorkspaceDeleted(service, workspaceIdForDeleteCheck))
      return NextResponse.json({ state: 'revoked' })

    // Verify JWT with workspace-specific secret — jwt_secret lives in
    // workspace_secrets now, not on workspaces itself — see migration 013.
    const workspace = sow.projects?.workspaces
    const jwtOk = workspace?.id ? await verifySowJwt(service, token, workspace.id) : false
    if (!jwtOk) {
      // Token expired or invalid signature
      if (sow.expires_at && new Date(sow.expires_at) < new Date()) {
        return NextResponse.json({ state: 'expired' })
      }
      return NextResponse.json({ state: 'invalid' })
    }

    return NextResponse.json(await buildSowResponse(sow, service, request.headers.get('user-agent')))
  } catch (err) {
    console.error('Portal SOW fetch error:', err)
    return NextResponse.json({ state: 'invalid' })
  }
}

async function buildSowResponse(sow: any, service: any, userAgent: string | null) {
  if (sow.status === 'signed') {
    return {
      state: 'signed',
      signedBy: sow.signed_by, signedAt: sow.signed_at,
      clientSignatureData: sow.client_signature_data || null,
    }
  }
  if (sow.status === 'withdrawn')  return { state: 'withdrawn' }
  if (sow.status === 'declined')   return { state: 'declined' }
  if (sow.status === 'expired')    return { state: 'expired' }
  // BUG: changes_requested was never checked here, so revisiting a link
  // after requesting changes fell through to the default case below and
  // re-served the full signing form as if nothing had happened.
  if (sow.status === 'changes_requested') return { state: 'changes_requested' }

  // FEATURE (portal audit, section 18): first time this document is
  // actually opened while still awaiting a response — the one signal this
  // portal never captured. Guarded with .is('first_viewed_at', null) so a
  // second near-simultaneous request doesn't matter (last-write-wins on
  // the same timestamp value is harmless), and failure here must never
  // block the client from actually seeing the document.
  if (!sow.first_viewed_at) {
    await markFirstViewed(service, {
      kind: 'sow', id: sow.id, workspaceId: sow.projects?.workspaces?.id, projectId: sow.projects?.id,
      projectName: sow.projects?.name || '', clientName: sow.projects?.clients?.name || '',
      userAgent,
    })
  }

  // Build logo URL if exists
  const workspace = sow.projects?.workspaces
  let logoUrl: string | null = null
  // FIX (re-audit, section 18): unguarded — the CO GET route, invoice GET route, and this SOW
  // route's own PDF route all defensively use `?.` for the identical lookup. If sow.projects or
  // sow.projects.workspaces were ever null (a project/workspace data-integrity edge case), this
  // threw, got swallowed by the outer catch, and told a client with a perfectly valid link "Link
  // not found" instead of degrading gracefully like every sibling route does.
  if (workspace?.logo_storage_path) {
    const { data: urlData } = await (service as any).storage
      .from('logos')
      .getPublicUrl(workspace.logo_storage_path)
    logoUrl = urlData?.publicUrl || null
  }

  const project = sow.projects
  const client  = project?.clients

  // FIX (doc-completeness audit): payment schedule was never fetched
  // for this page either — the client reviewed and signed the SOW
  // without ever seeing the milestone/payment schedule that the PDF
  // (generated only after signing) already showed.
  const { data: milestones } = await (service as any)
    .from('payment_milestones')
    .select('title, amount, percentage, trigger, due_date, status')
    .eq('sow_id', sow.id)
    .order('due_date', { ascending: true, nullsFirst: false })

  return {
    sow: {
      id:            sow.id,
      // FIX (re-audit, section 18): project/workspace accessed unguarded throughout this block —
      // the same inconsistency as the logo lookup above (see that fix's comment). Guarded the same
      // way the CO and invoice GET routes already guard the identical fields (`?.` with a sane
      // fallback), so a project/workspace data-integrity edge case degrades to a thinner response
      // instead of throwing and telling a client with a valid link "Link not found."
      projectName:   (project?.name || '') + (project?.disc ? ` — ${project.disc}` : ''),
      agencyName:    workspace?.agency_name,
      brandColour:   workspace?.brand_colour || '#1A5C3A',
      logoUrl,
      // FIX (bug — React error #31): legal_address/billing_address are
      // jsonb objects ({line1, line2, city, region, postalCode,
      // country}), not strings. They were being passed straight through
      // and rendered as a raw object in JSX on this page, which crashes
      // React at render time (only surfaces once a workspace/client
      // actually has an address on file — empty ones never hit this).
      // Format to a display string here, matching what the PDF's
      // formatAddress does, so the API contract for this field actually
      // matches the `string | null` the page's interface always claimed.
      agencyAddress: formatAddress(workspace?.legal_address) || null,
      agencyTaxId:   workspace?.tax_id || null,
      agencyPhone:   workspace?.phone || null,
      agencyWebsite: workspace?.website || null,
      agencySignatureData: workspace?.agency_signature_data || null,
      contractValue: project?.contract_value || 0,
      currency:      project?.currency || 'USD',
      // FIX (section-9 audit, 9-G7): the portal renders the same
      // schema-driven tables the PDF does, so it needs the drafting
      // language to localize their column headers.
      language:      sow.metadata?.language || 'en',
      clientName:    client?.name || '',
      clientEmail:   client?.email || '',
      clientCompany: client?.company_name || null,
      clientBillingAddress: formatAddress(client?.billing_address) || null,
      clientVatNumber:      client?.vat_number || null,
      // Hidden sections are the agency's decision NOT to show this text to the client — never ship
      // their content over the wire (it was returned with visible:false and only hidden by the
      // page). hydrateSections also repairs legacy HTML-escaped table cells.
      sections:      hydrateSections(sow.sections || [], sow.metadata).filter((sec: any) => sec.visible !== false),
      paymentSchedule: (milestones || []).map((m: any) => ({
        title: m.title, amount: m.amount, percentage: m.percentage,
        trigger: m.trigger, dueDate: m.due_date, status: m.status,
      })),
      version:       sow.version,
      expiresAt:     sow.expires_at,
    },
  }
}
