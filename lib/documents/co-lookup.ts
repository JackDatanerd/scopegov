// lib/documents/co-lookup.ts
//
// supabase-js never throws: a failed read resolves to { data: null, error }. Every CO route answered `!co` with a 404, so a
// transient database failure (or a PostgREST embed error) told the user their change order "was not found" - and the editor
// rendered that as a missing document rather than a retryable outage. Only "no row" (PGRST116 from .single()) and a
// malformed id (22P02, invalid uuid text) are genuine not-founds; anything else is a failed lookup and must be a 500.

import { NextResponse } from 'next/server'

export function isRealLookupFailure(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && error.code !== 'PGRST116' && error.code !== '22P02'
}

/** The response for a change-order (or attachment) lookup that came back empty: a 500 for a failed read, else the 404. */
export function lookupMissResponse(error: { code?: string; message?: string } | null | undefined, notFoundMessage: string): NextResponse {
  if (isRealLookupFailure(error)) {
    console.error('CO lookup failed:', error?.code, error?.message)
    return NextResponse.json({ error: 'Could not load this change order — please try again.' }, { status: 500 })
  }
  return NextResponse.json({ error: notFoundMessage }, { status: 404 })
}
