export const runtime = 'nodejs'

import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { jwtVerify } from 'jose'
import { logAudit } from '@/lib/utils/audit'
import { sendCoAcceptedEmail } from '@/lib/email/templates'

async function getCoByToken(token: string, service: any) {
  const { data: revoked } = await (service as any)
    .from('revoked_tokens').select('reason').eq('token', token).single()
  if (revoked) return { state: revoked.reason === 'declined' ? 'declined' : 'revoked' }

  const { data: co } = await (service as any)
    .from('change_orders')
    .select(`id,title,note,status,version,line_items,subtotal,tax_rate,tax_inclusive,
      total,expires_at,flag_id,workspace_id,
      projects(id,name,currency,clients(name,email,cc_emails),
        workspaces(id,agency_name,brand_colour,logo_storage_path,jwt_secret))`)
    .eq('token', token).single()

  if (!co) return { state: 'invalid' }

  const ws = co.projects?.workspaces
  try {
    const secret = new TextEncoder().encode(ws.jwt_secret)
    await jwtVerify(token, secret)
  } catch {
    if (co.expires_at && new Date(co.expires_at) < new Date()) return { state: 'expired' }
    return { state: 'invalid' }
  }

  // BUG: 'closed', 'stalled', and 'countered' were never included here, so
  // revisiting the link for a CO in any of those states fell through to the
  // default case below and re-served the full accept/decline/counter form.
  if (['accepted','declined','withdrawn','closed','stalled','countered'].includes(co.status)) return { state: co.status }

  return { co }
}

// GET — return CO data for portal
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const service   = createServiceClient()
    const result    = await getCoByToken(token, service)

    if (result.state) return NextResponse.json({ state: result.state })

    const co  = result.co!
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
        projectName: co.projects?.name,
        agencyName:  ws?.agency_name,
        brandColour: ws?.brand_colour || '#1A5C3A',
        logoUrl,
        lineItems,
        subtotal:    co.subtotal,
        taxRate:     co.tax_rate,
        taxInclusive: co.tax_inclusive,
        total:       co.total,
        currency:    co.projects?.currency || 'USD',
        clientName:  co.projects?.clients?.name || '',
        version:     co.version,
        expiresAt:   co.expires_at,
      },
    })
  } catch (err) {
    return NextResponse.json({ state: 'invalid' })
  }
}
