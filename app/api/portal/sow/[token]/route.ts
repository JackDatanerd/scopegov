export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service   = createServiceClient()

    // Check revoked tokens first
    const { data: revoked } = await (service as any)
      .from('revoked_tokens')
      .select('reason')
      .eq('token', token)
      .single()

    if (revoked) {
      return NextResponse.json({
        state: revoked.reason === 'declined' ? 'declined'
          : revoked.reason === 'withdrawn' ? 'withdrawn'
          : 'revoked',
      })
    }

    // Find SOW by token
    const { data: sow } = await (service as any)
      .from('sow_documents')
      .select(`id, version, status, sections, metadata, expires_at, signed_at,
        projects(id, name, disc, contract_value, currency, client_id,
          clients(name, email),
          workspaces(id, agency_name, brand_colour, logo_storage_path, jwt_secret))`)
      .eq('token', token)
      .single()

    if (!sow) return NextResponse.json({ state: 'invalid' })

    // Verify JWT with workspace-specific secret
    const workspace = sow.projects?.workspaces
    try {
      const secret = new TextEncoder().encode(workspace.jwt_secret)
      await jwtVerify(token, secret)
    } catch {
      // Token expired or invalid signature
      if (sow.expires_at && new Date(sow.expires_at) < new Date()) {
        return NextResponse.json({ state: 'expired' })
      }
      return NextResponse.json({ state: 'invalid' })
    }

    if (sow.status === 'signed')     return NextResponse.json({ state: 'signed' })
    if (sow.status === 'withdrawn')  return NextResponse.json({ state: 'withdrawn' })
    if (sow.status === 'declined')   return NextResponse.json({ state: 'declined' })
    if (sow.status === 'expired')    return NextResponse.json({ state: 'expired' })

    // Build logo URL if exists
    let logoUrl: string | null = null
    if (workspace.logo_storage_path) {
      const { data: urlData } = await (service as any).storage
        .from('logos')
        .getPublicUrl(workspace.logo_storage_path)
      logoUrl = urlData?.publicUrl || null
    }

    const project = sow.projects
    const client  = project?.clients

    return NextResponse.json({
      sow: {
        id:            sow.id,
        projectName:   project.name + (project.disc ? ` — ${project.disc}` : ''),
        agencyName:    workspace.agency_name,
        brandColour:   workspace.brand_colour || '#1A5C3A',
        logoUrl,
        contractValue: project.contract_value || 0,
        currency:      project.currency || 'USD',
        clientName:    client?.name || '',
        clientEmail:   client?.email || '',
        sections:      sow.sections || [],
        version:       sow.version,
        expiresAt:     sow.expires_at,
      },
    })
  } catch (err) {
    console.error('Portal SOW fetch error:', err)
    return NextResponse.json({ state: 'invalid' })
  }
}
