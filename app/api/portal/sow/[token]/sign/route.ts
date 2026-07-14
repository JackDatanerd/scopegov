export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { logAudit } from '@/lib/utils/audit'
import { sendSowSignedAgencyEmail, sendSowSignedClientEmail } from '@/lib/email/templates'
import { nanoid } from 'nanoid'
import { getMemberEmailsWithPermission } from '@/lib/utils/permissions-query'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token }      = await params
    const { signerName, signatureData } = await request.json()
    const ip             = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown'

    if (!signerName || signerName.trim().length < 3)
      return NextResponse.json({ error: 'Full name required to sign' }, { status: 400 })
    if (!signatureData || typeof signatureData !== 'string' || !signatureData.startsWith('data:image/'))
      return NextResponse.json({ error: 'Please draw your signature to sign' }, { status: 400 })

    const service = createServiceClient()

    // Check revoked
    const { data: revoked } = await (service as any)
      .from('revoked_tokens').select('id').eq('token', token).single()
    if (revoked) return NextResponse.json({ error: 'This link is no longer active' }, { status: 410 })

    // Fetch SOW
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, status, sections, metadata, expires_at, project_id, workspace_id,
        projects(id, name, disc, currency, contract_value, client_id, created_by,
          clients(name, email, cc_emails),
          workspaces(id, agency_name, brand_colour, jwt_secret, first_sow_signed_at))`)
      .eq('token', token).single()

    if (!sow) return NextResponse.json({ error: 'SOW not found' }, { status: 404 })
    if (sow.status !== 'awaiting_signature')
      return NextResponse.json({ error: 'This SOW is no longer awaiting signature' }, { status: 409 })
    if (sow.expires_at && new Date(sow.expires_at) < new Date())
      return NextResponse.json({ error: 'This link has expired' }, { status: 410 })

    // Verify JWT
    try {
      const secret = new TextEncoder().encode(sow.projects.workspaces.jwt_secret)
      await jwtVerify(token, secret)
    } catch {
      return NextResponse.json({ error: 'Invalid or expired signing link' }, { status: 401 })
    }

    const now     = new Date().toISOString()
    const project = sow.projects
    const client  = project.clients
    const ws      = project.workspaces

    // ── 1. Mark SOW signed ───────────────────────────────────
    await (service as any).from('sow_documents').update({
      status:      'signed',
      signed_at:   now,
      signed_by:   signerName.trim(),
      signer_email: client.email,
      signer_ip:   ip,
      client_signature_data: signatureData,
      updated_at:  now,
    }).eq('id', sow.id)

    // ── 2. Update project → Active ───────────────────────────
    await (service as any).from('projects').update({
      status:        'Active',
      updated_at:    now,
    }).eq('id', project.id).neq('status', 'Active')

    // ── 3. Set guardian email ─────────────────────────────────
    // Format: proj-{8chars of sowId}@guard.scopegov.app (carry-forward §2.4)
    const guardianDomain = process.env.NEXT_PUBLIC_GUARDIAN_EMAIL_DOMAIN || 'guard.scopegov.app'
    const guardianEmail  = `proj-${sow.id.replace(/-/g,'').slice(0,8)}@${guardianDomain}`
    await (service as any).from('projects').update({ guardian_email: guardianEmail }).eq('id', project.id)

    // ── 4. Create scope snapshot (spec §0.13 — in same transaction) ─
    const sections     = sow.sections || []
    const deliverables = extractDeliverables(sections.find((s: any) => s.id === 'deliverables')?.content || '')
    const outOfScope   = extractDeliverables(sections.find((s: any) => s.id === 'oos')?.content || '')

    const { data: existingSnap } = await (service as any)
      .from('project_scope_snapshot').select('id').eq('project_id', project.id).single()

    if (existingSnap) {
      await (service as any).from('project_scope_snapshot').update({
        deliverables, out_of_scope: outOfScope,
        last_updated_at: now, last_updated_by: 'signing',
      }).eq('project_id', project.id)
    } else {
      await (service as any).from('project_scope_snapshot').insert({
        project_id:      project.id,
        deliverables,
        out_of_scope:    outOfScope,
        last_updated_at: now,
        last_updated_by: 'signing',
      })
    }

    // ── 5. Mark firstSowSignedAt if null ─────────────────────
    if (!ws.first_sow_signed_at) {
      await (service as any).from('workspaces').update({
        first_sow_signed_at: now,
      }).eq('id', sow.workspace_id)
    }

    // ── 6. Create payment milestones from SOW metadata ────────
    await createMilestones(service, project.id, sow.id, sow.metadata, project.contract_value, project.currency)

    // ── 7. Audit log ──────────────────────────────────────────
    await logAudit(service, {
      workspaceId: sow.workspace_id, actorId: client.email,
      actorEmail: client.email, actorName: signerName.trim(),
      eventType: 'sow.signed', entityType: 'sow',
      entityId: sow.id, entityName: project.name,
      metadata: { version: sow.version, signer_ip: ip, guardian_email: guardianEmail },
    })

    // ── 8. Notify SEND_SOW holders (Event 3) — awaited ───────
    try {
      const agencyEmails = await getMemberEmailsWithPermission(service, sow.workspace_id, 'SEND_SOW', 25, 'sow_signed')
      if (agencyEmails.length) {
        await sendSowSignedAgencyEmail({
          to:          agencyEmails,
          agencyName:  ws.agency_name,
          clientName:  client.name,
          projectName: project.name + (project.disc ? ` — ${project.disc}` : ''),
          signedBy:    signerName.trim(),
          portalUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/projects/${project.id}?tab=sow`,
        })
      }
    } catch (e) { console.error('Agency signed email failed:', e) }

    // ── 9. Confirm to client (Event 4) ───────────────────────
    try {
      await sendSowSignedClientEmail({
        to:          client.email,
        clientName:  client.name,
        agencyName:  ws.agency_name,
        projectName: project.name,
        portalUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/portal/sow/${token}`,
      })
    } catch (e) { console.error('Client confirm email failed:', e) }

    return NextResponse.json({ ok: true, guardianEmail })
  } catch (err) {
    console.error('SOW sign error:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}

function extractDeliverables(html: string): Array<{ title: string }> {
  if (!html) return []
  // Extract list items from HTML
  const items: Array<{ title: string }> = []
  const liRegex = /<li[^>]*>(.*?)<\/li>/gi
  let match
  while ((match = liRegex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '').trim()
    if (text) items.push({ title: text })
  }
  // Fallback: extract paragraphs
  if (!items.length) {
    const pRegex = /<p[^>]*>(.*?)<\/p>/gi
    while ((match = pRegex.exec(html)) !== null) {
      const text = match[1].replace(/<[^>]+>/g, '').trim()
      if (text && text.length > 3) items.push({ title: text })
    }
  }
  return items.slice(0, 50)
}

async function createMilestones(
  service: any, projectId: string, sowId: string,
  metadata: any, contractValue: number, currency: string
) {
  try {
    const structure = metadata?.paymentStructure || '50_50'
    const milestones = []

    if (structure === '50_50') {
      milestones.push(
        { title: 'Upfront payment (50%)',   amount: contractValue * 0.5, trigger: 'Project kick-off',       type: 'percentage', percentage: 50 },
        { title: 'Final payment (50%)',      amount: contractValue * 0.5, trigger: 'Final delivery approval', type: 'percentage', percentage: 50 },
      )
    } else if (structure === '100_upfront') {
      milestones.push({ title: 'Full payment', amount: contractValue, trigger: 'Before work commences', type: 'fixed', percentage: null })
    } else if (structure === 'on_delivery') {
      milestones.push({ title: 'Full payment', amount: contractValue, trigger: 'Final delivery approval', type: 'fixed', percentage: null })
    } else if (structure === 'monthly') {
      milestones.push({ title: 'Monthly retainer', amount: contractValue, trigger: 'Monthly — first of month', type: 'retainer_monthly', percentage: null })
    } else {
      milestones.push({ title: 'Project payment', amount: contractValue, trigger: 'As per agreement', type: 'fixed', percentage: null })
    }

    for (const m of milestones) {
      await (service as any).from('payment_milestones').insert({
        project_id:   projectId,
        sow_id:       sowId,
        title:        m.title,
        type:         m.type,
        amount:       m.amount,
        percentage:   m.percentage,
        trigger:      m.trigger,
        tax_rate:     0,
        tax_inclusive: false,
        status:       'pending',
      })
    }
  } catch (e) { console.error('Milestone creation failed:', e) }
}
