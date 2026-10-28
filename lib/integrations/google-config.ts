// lib/integrations/google-config.ts
//
// Google OAuth configuration for the Drive archive. Server-only.
//
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   an OAuth client of type "Web application" (console.cloud.google.com ->
//                                              APIs & Services -> Credentials). Its authorised redirect URI must be exactly
//                                              ${NEXT_PUBLIC_APP_URL}/api/integrations/google/callback
//
// SCOPES — deliberately the narrowest that does the job:
//   drive.file   the app can see and change ONLY files and folders it created itself. It cannot read the rest of the
//                person's Drive. (Google classes this as a non-sensitive scope; confirm the current rules in your consent
//                screen's "Verification status" before launch — see integrations/google-drive/README.md.)
//   openid email shows which Google account is connected. Non-sensitive.

import { signOAuthState, verifyOAuthState, type OAuthState, type StateCheck } from './oauth-state'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const GOOGLE_SCOPES = [DRIVE_FILE_SCOPE, 'openid', 'email'] as const
export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
export const ARCHIVE_ROOT_NAME = 'ScopeGov Archive'

export const googleConfigured = (env: NodeJS.ProcessEnv = process.env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)

export function googleRedirectUri(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = (env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
  return /^https?:\/\//.test(base) ? `${base}/api/integrations/google/callback` : null
}

export function googleAuthorizeUrl(state: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const redirect = googleRedirectUri(env)
  if (!googleConfigured(env) || !redirect) return null
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: redirect, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), state,
    access_type: 'offline',        // we need a refresh token: archiving happens long after the person has gone away
    prompt: 'consent',             // Google only returns a refresh token on a consent screen; without this a reconnect gets none
    include_granted_scopes: 'false',
  })
  return `${GOOGLE_AUTH_URL}?${q}`
}

export const signGoogleState = (s: OAuthState, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): string => signOAuthState('google', s, nowMs, env)
export const verifyGoogleState = (t: string | null | undefined, nowMs: number = Date.now(), env: NodeJS.ProcessEnv = process.env): StateCheck => verifyOAuthState('google', t, nowMs, env)

export const driveFolderUrl = (id: string) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`
