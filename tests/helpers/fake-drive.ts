// A small in-memory stand-in for the parts of Google's OAuth + Drive v3 API the archive uses, faithful where it matters:
// appProperties queries, parents, `trashed` (a trashed PARENT makes children trashed), 404 for a missing parent, resumable
// uploads in two steps, token refresh, one-shot 401s, and the failure modes Google really returns.
import type { GoogleCaller, GoogleRequest, GoogleResponse } from '@/lib/integrations/google'

export interface DriveFile { id: string; name: string; mimeType: string; parents: string[]; appProperties: Record<string, string>; trashed: boolean; bytes?: Buffer }

export class FakeDrive {
  files = new Map<string, DriveFile>()
  calls: GoogleRequest[] = []
  tokensIssued = 0
  revoked: string[] = []
  seq = 0
  // failure switches
  tokenError: string | null = null          // refresh answers 400 {error}
  reject401 = 0                              // next N Drive calls answer 401
  quotaFull = false                          // upload PUT answers 403 storageQuotaExceeded
  rateLimited = 0                            // next N Drive calls answer 403 rateLimitExceeded
  serverError = 0                            // next N Drive calls answer 503
  apiDisabled = false                        // Drive API not enabled for the project
  evilLocation: string | null = null         // upload init answers a Location we must not follow
  exchange: any = null                       // body of the authorization_code exchange

  private pending = new Map<string, any>()
  private ok = (json: any, status = 200, extra: Partial<GoogleResponse> = {}): GoogleResponse => ({ status, json, location: null, retryAfter: null, ...extra })
  private err = (status: number, reason: string, message = reason) => this.ok({ error: { code: status, message, errors: [{ reason }] } }, status)

  call: GoogleCaller = async (req) => {
    this.calls.push(req)
    const url = new URL(req.url)
    if (url.hostname === 'oauth2.googleapis.com') {
      if (url.pathname === '/revoke') { this.revoked.push(req.form?.token || ''); return this.ok({}) }
      if (req.form?.grant_type === 'authorization_code') return this.exchange ? this.ok(this.exchange) : this.ok({ error: 'invalid_grant' }, 400)
      if (this.tokenError) return this.ok({ error: this.tokenError }, 400)
      return this.ok({ access_token: `at-${++this.tokensIssued}`, expires_in: 3600 })
    }
    // Drive from here on
    if (this.apiDisabled) return this.err(403, 'accessNotConfigured')
    if (this.serverError > 0) { this.serverError--; return this.ok({}, 503) }
    if (this.rateLimited > 0) { this.rateLimited--; return this.err(403, 'rateLimitExceeded') }
    const isUploadSession = url.pathname.startsWith('/upload/drive/v3/files') && url.searchParams.has('upload_id')
    if (!isUploadSession) {
      if (this.reject401 > 0) { this.reject401--; return this.ok({ error: { code: 401, message: 'Invalid Credentials' } }, 401) }
      if (!/^Bearer at-\d+$/.test(req.headers?.Authorization || '')) return this.ok({ error: { code: 401 } }, 401)
    }

    // files.list
    if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q') || ''
      const value = /value='([^']+)'/.exec(q)?.[1]
      const parent = /'([^']+)' in parents/.exec(q)?.[1]
      const wantFolder = q.includes("mimeType='application/vnd.google-apps.folder'")
      const hits = [...this.files.values()].filter(f => !this.isTrashed(f) && Object.values(f.appProperties).includes(value || '\0') &&
        (!parent || f.parents.includes(parent)) && (!wantFolder || f.mimeType === 'application/vnd.google-apps.folder'))
      return this.ok({ files: hits.slice(0, 1).map(f => ({ id: f.id, webViewLink: `https://drive.google.com/file/d/${f.id}/view` })) })
    }
    // files.get
    const get = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && get) {
      const f = this.files.get(decodeURIComponent(get[1]))
      return f ? this.ok({ id: f.id, trashed: this.isTrashed(f) }) : this.err(404, 'notFound', `File not found: ${get[1]}`)
    }
    // folder create
    if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
      const m = JSON.parse(String(req.body))
      for (const p of m.parents || []) if (!this.files.has(p)) return this.err(404, 'notFound', `File not found: ${p}`)
      const f = this.add({ name: m.name, mimeType: m.mimeType, parents: m.parents || [], appProperties: m.appProperties || {} })
      return this.ok({ id: f.id })
    }
    // resumable init
    if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'resumable') {
      const m = JSON.parse(String(req.body))
      for (const p of m.parents || []) if (!this.files.has(p)) return this.err(404, 'notFound', `File not found: ${p}`)
      const sid = `session-${++this.seq}`
      this.pending.set(sid, m)
      return this.ok({}, 200, { location: this.evilLocation || `https://www.googleapis.com/upload/drive/v3/files?upload_id=${sid}&uploadType=resumable` })
    }
    // resumable PUT
    if (req.method === 'PUT' && isUploadSession) {
      if (this.quotaFull) return this.err(403, 'storageQuotaExceeded', 'The user storage quota has been exceeded.')
      const m = this.pending.get(url.searchParams.get('upload_id') || '')
      if (!m) return this.err(404, 'notFound')
      const f = this.add({ name: m.name, mimeType: m.mimeType, parents: m.parents || [], appProperties: m.appProperties || {}, bytes: Buffer.from(req.body as Buffer) })
      return this.ok({ id: f.id, webViewLink: `https://drive.google.com/file/d/${f.id}/view` }, 200)
    }
    return this.err(400, 'badRequest', `unhandled ${req.method} ${req.url}`)
  }

  add(p: Omit<DriveFile, 'id' | 'trashed'>): DriveFile { const f = { id: `drv-${++this.seq}`, trashed: false, ...p }; this.files.set(f.id, f); return f }
  isTrashed(f: DriveFile): boolean { return f.trashed || f.parents.some(p => { const par = this.files.get(p); return !!par && this.isTrashed(par) }) }
  trash(id: string) { this.files.get(id)!.trashed = true }
  remove(id: string) { this.files.delete(id) }
  folders() { return [...this.files.values()].filter(f => f.mimeType === 'application/vnd.google-apps.folder') }
  pdfs() { return [...this.files.values()].filter(f => f.mimeType === 'application/pdf') }
  pathOf(f: DriveFile): string { const par = f.parents[0] ? this.files.get(f.parents[0]) : null; return (par ? this.pathOf(par) + ' / ' : '') + f.name }
  writes() { return this.calls.filter(c => c.method !== 'GET' && !c.url.includes('oauth2')) }
}
