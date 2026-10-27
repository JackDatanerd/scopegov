// lib/integrations/api-route.ts
//
// Shared front door for the API-key routes under /api/integrations/v1. Server-only (imports the service client).

import { NextResponse, type NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { authenticateApiKey, type ApiKeyAuth } from './api-keys'

/** Every failure is the same 401, so a probe learns nothing about which keys exist or why one was refused. */
export async function withApiKey(request: NextRequest): Promise<{ service: any; auth: ApiKeyAuth } | { response: NextResponse }> {
  const service = createServiceClient() as any
  const auth = await authenticateApiKey(service, request.headers.get('authorization'))
  if (!auth) return { response: NextResponse.json({ error: 'Invalid API key' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }) }
  return { service, auth }
}
