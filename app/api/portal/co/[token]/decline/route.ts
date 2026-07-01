export const runtime = 'nodejs'
import { NextResponse, type NextRequest } from 'next/server'
import { POST_DECLINE } from '../_actions'

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return POST_DECLINE(request, token)
}
