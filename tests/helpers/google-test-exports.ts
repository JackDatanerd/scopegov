// Re-exports so the Drive tests import config from one place.
export { googleAuthorizeUrl, googleConfigured, googleRedirectUri, signGoogleState, verifyGoogleState, GOOGLE_SCOPES, DRIVE_FILE_SCOPE } from '@/lib/integrations/google-config'
export const STATE_TTL_MS_FOR_TEST = 10 * 60 * 1000
