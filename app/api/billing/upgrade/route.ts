import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'
import { getSession, hasPermission } from '@/lib/auth/session'

export async function POST(request: NextRequest) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!hasPermission(session, 'MANAGE_BILLING'))
      return NextResponse.json({ error: 'Missing permission: MANAGE_BILLING' }, { status: 403 })

    const { planKey, interval = 'monthly' } = await request.json()
    if (!planKey) return NextResponse.json({ error: 'planKey required' }, { status: 400 })

    // Map planKey + interval to Paystack plan code
    const envKey    = `PAYSTACK_PLAN_${planKey.toUpperCase()}_${interval.toUpperCase()}`
    const planCode  = process.env[envKey]
    if (!planCode)
      return NextResponse.json({ error: `Plan code not configured: ${envKey}` }, { status: 422 })

    const service = createServiceClient()
    const { data: user } = await (service as any)
      .from('users').select('email').eq('id', session.id).single()

    return NextResponse.json({
      planCode,
      email:     user?.email || session.email,
      publicKey: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
      callbackUrl: `${process.env.NEXT_PUBLIC_APP_URL}/settings?tab=billing&upgraded=1`,
      metadata: {
        workspaceId: session.workspaceId,
        planKey,
        interval,
        userId: session.id,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Error' }, { status: 500 })
  }
}
