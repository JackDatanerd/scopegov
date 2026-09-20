export const runtime = 'nodejs'

import { NextResponse } from 'next/server'

// RETIRED (Auth independent audit). This endpoint used to log a
// `security.password_changed` audit row and email the account owner on request
// from ANY signed-in session, with nothing proving a password had actually
// changed — so it could be called in a loop to forge audit rows and spam the
// owner with "your password was changed" emails.
//
// Password changes are now audited by a trigger on auth.users (migration 064)
// and the reset flow runs server-side in /api/auth/reset-password. Nothing calls
// this route any more; it answers 410 so a reset page loaded before the deploy
// fails harmlessly. Safe to delete this file.
export async function POST() {
  return NextResponse.json({ error: 'This endpoint has been retired.' }, { status: 410 })
}
