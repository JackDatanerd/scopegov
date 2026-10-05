// lib/utils/upload-limits.ts
//
// FIX (Guardian section 13, pass 14 - B1): every evidence / attachment upload route advertised and enforced a 10 MB
// cap, but the app is deployed on Vercel, whose functions refuse any request body over 4.5 MB with a platform 413
// (FUNCTION_PAYLOAD_TOO_LARGE) BEFORE the route runs. A 4.5-10 MB file therefore always failed with a generic
// "too large" (or an unreadable non-JSON body) while the UI and API both promised 10 MB. The cap is now one shared
// number below the platform limit (multipart framing adds a little to the file itself), so the limit the person is
// told about is the limit that actually works.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
export const MAX_UPLOAD_LABEL = '4 MB'
/** Reject by Content-Length above this - the file cap plus multipart framing, still under the platform limit. */
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_BYTES + 256 * 1024
