// lib/utils/account-erasure.ts
//
// FIX (cron/portal audit round 2 — flagship finding). "Deleting" an account only ever set
// public.users.deleted_at; the 30-day cron then scrubbed public.users. The AUTH record
// (auth.users: real email, password hash, OAuth identities, MFA factors, metadata) was never touched,
// so the deleted person could keep signing in with their old credentials — nothing checked
// deleted_at at login — and could create or join a workspace, after which day 30 anonymized the row
// out from under a live member. A compliance product's erasure has to reach the auth record too.
//
//   banAuthUser        — immediately on deletion: the account can no longer sign in or refresh.
//   anonymizeAuthUser  — at day 30: replace the login email with a non-routable one, set an unknown
//                        password, drop metadata (display name, avatar) and remove MFA factors.
//
// KNOWN LIMIT: the GoTrue admin API offers no call to delete OAuth identity rows
// (auth.identities.identity_data still holds the provider's email/name). The ban stops them being
// usable; to purge them completely, run the SQL in migration 063's footer or use the dashboard.

import { randomBytes } from 'node:crypto'

const BAN_FOREVER = '876000h' // ~100 years

export async function banAuthUser(service: any, userId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { error } = await service.auth.admin.updateUserById(userId, { ban_duration: BAN_FOREVER })
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/** True when the auth user is currently banned (so the daily sweep doesn't re-ban everyone every run). */
export async function isAuthUserBanned(service: any, userId: string): Promise<boolean | null> {
  try {
    const { data, error } = await service.auth.admin.getUserById(userId)
    if (error) return null
    const until = (data?.user as any)?.banned_until
    return !!until && new Date(until).getTime() > Date.now()
  } catch { return null }
}

export function anonymizedEmail(userId: string): string {
  return `deleted-${userId}@deleted.scopegov.app`
}

/**
 * Returns ok:true when the auth record is anonymized (or no longer exists). On failure the caller must
 * NOT anonymize public.users, so the next daily run finds the row again and retries.
 */
export async function anonymizeAuthUser(service: any, userId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // FIX (fresh independent audit, Workspace lifecycle + Onboarding —
    // traced out-of-section, since it's the same GoTrue call
    // workspace/profile/route.ts makes): the admin updateUserById call
    // below merges `user_metadata` key-by-key rather than replacing it —
    // GoTrue's own model layer "sets all user data from a map of
    // updates, ensuring it doesn't override attributes that are not in
    // the provided map," and only an explicit `null` for a given key
    // deletes it. Passing `{}` (as this used to) has zero keys, so the
    // merge touches nothing at all: the real display name — and
    // anything else living in user_metadata, such as an OAuth-provided
    // avatar_url/name or terms_version — survived completely intact in
    // auth.users.raw_user_meta_data, forever, directly contradicting
    // this very function's own header comment above ("drop metadata
    // (display name, avatar)") and this file's stated purpose as a
    // compliance product's erasure. Fetch whatever keys actually exist
    // and null out every one of them explicitly, so the merge actually
    // deletes them instead of silently no-op'ing.
    const { data: existing, error: getError } = await service.auth.admin.getUserById(userId)
    if (getError) {
      // Already gone from auth (hard-deleted elsewhere): nothing left to erase there.
      if ((getError as any).status === 404 || /not found/i.test(getError.message || '')) return { ok: true }
      return { ok: false, error: getError.message }
    }
    const existingMetadata = (existing?.user as any)?.user_metadata || {}
    const clearedMetadata: Record<string, null> = {}
    for (const key of Object.keys(existingMetadata)) clearedMetadata[key] = null

    const { error } = await service.auth.admin.updateUserById(userId, {
      email: anonymizedEmail(userId),
      email_confirm: true,                      // no confirmation mail to the placeholder address
      password: randomBytes(32).toString('base64url'),
      user_metadata: clearedMetadata,
      ban_duration: BAN_FOREVER,
    })
    if (error) {
      // Already gone from auth (hard-deleted elsewhere): nothing left to erase there.
      if ((error as any).status === 404 || /not found/i.test(error.message)) return { ok: true }
      return { ok: false, error: error.message }
    }
    // MFA factors are credentials tied to the person; remove them (best effort — the ban already
    // blocks sign-in, so a failure here is reported, not fatal).
    try {
      const { data } = await service.auth.admin.mfa.listFactors({ userId })
      for (const f of data?.factors || []) {
        await service.auth.admin.mfa.deleteFactor({ id: f.id, userId })
      }
    } catch (e) { console.error('[account-erasure] MFA factor cleanup failed for', userId, e) }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}
