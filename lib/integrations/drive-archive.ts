// lib/integrations/drive-archive.ts
//
// Archive ONE executed document (a signed SOW or an accepted change order) into the agency's own Google Drive as its frozen PDF:
//
//     ScopeGov Archive / <Client> / <Project> / SOW-Website-v1-signed.pdf
//
// Properties this is built to keep:
//   • FROZEN PDFs ONLY. It uploads the stored executed PDF byte for byte (lib/documents/executed-pdf.ts). A document with no
//     stored copy is reported, never re-rendered: a fresh render can differ from what was signed, which is the whole reason
//     the frozen copy exists.
//   • IDEMPOTENT. integration_external_refs remembers the Drive file made for each document; a retry, a duplicate event or a
//     second "archive past documents" click is a no-op. If a crash left a file in Drive without its ref, the next attempt finds
//     it again by its appProperties instead of uploading a second copy.
//   • SELF-HEALING. If the person deletes or trashes the archive folder, the next document recreates the folders (once).
//   • NARROW. Only the drive.file scope: it can only ever touch what it created.
//   • TENANT-SAFE. The document must belong to the event's workspace and be in its executed state.

import { fetchExecutedPdf } from '@/lib/documents/executed-pdf'
import { sowPdfFilename } from '@/lib/documents/sow-pdf-name'
import { coPdfFilename } from '@/lib/documents/co-pdf-name'
import { decryptSecret } from './crypto'
import { accessToken, classifyGoogle, forgetAccessToken, type GoogleCaller, type GoogleVerdict } from './google'
import { ARCHIVE_ROOT_NAME, DRIVE_FILES_URL } from './google-config'

export const MAX_PDF_BYTES = 25 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'

export type ArchiveOutcome = { verdict: GoogleVerdict; already?: boolean; fileId?: string; fileUrl?: string | null; note?: string }

export interface DriveCtx {
  service: any
  connection: { id: string; workspace_id: string; credentials_enc: string | null }
  call: GoogleCaller
  env?: NodeJS.ProcessEnv
}

export interface ArchiveInput {
  service: any
  connection: { id: string; workspace_id: string; credentials_enc: string | null }
  event: { id: string; workspace_id: string; project_id: string | null; data: any }
  project: { id: string; name: string | null; clients?: { id: string; name: string | null } | null } | null
  call: GoogleCaller
  env?: NodeJS.ProcessEnv
}

const permanent = (error: string): ArchiveOutcome => ({ verdict: { outcome: 'permanent', error } })

/** A Drive-safe, readable folder/file name. */
export function driveName(raw: unknown, fallback: string): string {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100)
  return s || fallback
}

const DOC_SPEC = {
  sow: { table: 'sow_documents', select: 'id, workspace_id, project_id, status, pdf_path, document_number, version', executed: 'signed' },
  change_order: { table: 'change_orders', select: 'id, workspace_id, project_id, status, pdf_path, document_number, title', executed: 'accepted' },
} as const

export async function archiveExecutedDocument(i: ArchiveInput): Promise<ArchiveOutcome> {
  const env = i.env || process.env
  const ref = i.event.data?.document
  const type = ref?.type as keyof typeof DOC_SPEC
  if (!ref || !DOC_SPEC[type] || typeof ref.id !== 'string' || !UUID.test(ref.id)) return permanent('This event does not refer to an archivable document.')
  const spec = DOC_SPEC[type]
  const fileKey = `${type}:${ref.id}`

  // 1. The document: must be this workspace's, and executed.
  const { data: doc, error: docErr } = await i.service.from(spec.table).select(spec.select).eq('id', ref.id).maybeSingle()
  if (docErr) return { verdict: { outcome: 'retry', error: `Could not read the document: ${docErr.message}` } }
  if (!doc || doc.workspace_id !== i.event.workspace_id) return permanent('The document no longer exists.')
  if (doc.status !== spec.executed) return permanent(`The document is not ${spec.executed} (status: ${doc.status}).`)

  // 2. Already archived? Then there is nothing to do — and nothing to upload twice.
  const existing = await findRef(i, 'file', fileKey)
  if (existing === 'error') return { verdict: { outcome: 'retry', error: 'Could not read archive records.' } }
  if (existing) return { verdict: { outcome: 'ok' }, already: true, fileId: existing.remote_id, fileUrl: existing.remote_url }

  // 3. The frozen PDF.
  if (!doc.pdf_path) return permanent('No stored executed PDF exists for this document (it was signed before executed PDFs were frozen, or storing it failed). It is not re-rendered, because a new render could differ from what was signed.')
  const pdf = await fetchExecutedPdf(i.service, doc.pdf_path)
  if (!pdf) return { verdict: { outcome: 'retry', error: 'The stored executed PDF could not be read.' } }
  if (pdf.length > MAX_PDF_BYTES) return permanent(`The PDF is ${(pdf.length / 1048576).toFixed(1)} MB, over the ${MAX_PDF_BYTES / 1048576} MB archive limit.`)

  // 4. Google access.
  let refresh: string
  try { refresh = JSON.parse(decryptSecret(i.connection.credentials_enc || '', `${i.connection.workspace_id}:${i.connection.id}`)).refresh_token } catch {
    return { verdict: { outcome: 'connection_off', error: 'Stored Google token unreadable', reason: 'The stored Google connection could not be read. Reconnect Google Drive.' } }
  }
  if (!refresh) return { verdict: { outcome: 'connection_off', error: 'No Google refresh token', reason: 'Reconnect Google Drive.' } }
  const tok = await accessToken(i.connection.id, refresh, i.call, env)
  if (!tok.ok) return { verdict: tok.verdict }
  const auth = { Authorization: `Bearer ${tok.token}` }

  const clientName = driveName(i.project?.clients?.name, 'No client')
  const projectName = driveName(i.project?.name, 'Project')
  const filename = type === 'sow'
    ? sowPdfFilename(i.project?.name, doc.version, doc.document_number, '-signed')
    : coPdfFilename(doc.document_number, doc.title, '-accepted')

  // 5. Folders → heal-check → upload. One retry if the folder turns out to have been deleted/trashed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const chain = await ensureFolders(i, auth, [
      { key: `root:${i.connection.workspace_id}`, name: ARCHIVE_ROOT_NAME },
      { key: `client:${i.project?.clients?.id || 'none'}`, name: clientName },
      { key: `project:${i.project?.id || i.event.project_id || 'none'}`, name: projectName },
    ])
    if ('verdict' in chain) {
      if (chain.verdict.outcome === 'folder_gone' && attempt === 0) { await purgeFolderRefs(i); continue }
      return chain.verdict.outcome === 'folder_gone' ? { verdict: { outcome: 'retry', error: chain.verdict.error } } : chain
    }
    const parent = chain.leaf

    // A previous attempt may have uploaded the file and died before recording it: find it instead of duplicating it.
    const found = await call(i, auth, 'GET', `${DRIVE_FILES_URL}?${new URLSearchParams({
      q: `appProperties has { key='scopegov_doc' and value='${fileKey}' } and '${parent}' in parents and trashed=false`,
      fields: 'files(id,webViewLink)', pageSize: '1', spaces: 'drive',
    })}`)
    if (found.verdict.outcome === 'folder_gone' && attempt === 0) { await purgeFolderRefs(i); continue }
    if (found.verdict.outcome !== 'ok') return { verdict: found.verdict.outcome === 'folder_gone' ? { outcome: 'retry', error: found.verdict.error } : found.verdict }
    const hit = found.json?.files?.[0]
    if (hit?.id) { await saveRef(i, 'file', fileKey, hit.id, filename, hit.webViewLink || null); return { verdict: { outcome: 'ok' }, already: true, fileId: hit.id, fileUrl: hit.webViewLink || null } }

    // Resumable upload (works for any size up to the cap): open a session, then send the bytes.
    const init = await call(i, auth, 'POST', `${UPLOAD_URL}?uploadType=resumable&fields=id,webViewLink`, {
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/pdf', 'X-Upload-Content-Length': String(pdf.length) },
      body: JSON.stringify({ name: filename, mimeType: 'application/pdf', parents: [parent], appProperties: { scopegov_doc: fileKey, scopegov_workspace: i.connection.workspace_id } }),
    })
    if (init.verdict.outcome === 'folder_gone' && attempt === 0) { await purgeFolderRefs(i); continue }
    if (init.verdict.outcome !== 'ok') return { verdict: init.verdict.outcome === 'folder_gone' ? { outcome: 'retry', error: init.verdict.error } : init.verdict }
    if (!init.location) return { verdict: { outcome: 'retry', error: 'Google did not open an upload session.' } }

    const put = await call(i, {}, 'PUT', init.location, { headers: { 'Content-Type': 'application/pdf' }, body: pdf, timeoutMs: 60_000, raw: true })
    if (put.verdict.outcome !== 'ok') return { verdict: put.verdict.outcome === 'folder_gone' ? { outcome: 'retry', error: put.verdict.error } : put.verdict }
    const fileId = put.json?.id
    if (typeof fileId !== 'string') return { verdict: { outcome: 'retry', error: 'Google accepted the upload but returned no file id.' } }
    await saveRef(i, 'file', fileKey, fileId, filename, put.json?.webViewLink || null)
    return { verdict: { outcome: 'ok' }, fileId, fileUrl: put.json?.webViewLink || null }
  }
  return { verdict: { outcome: 'retry', error: 'The archive folder kept disappearing; will try again.' } }
}

// ── Drive calls ──────────────────────────────────────────────────────────────
interface Called { verdict: GoogleVerdict; json: any; location: string | null }
async function call(i: DriveCtx, auth: Record<string, string>, method: 'GET' | 'POST' | 'PUT', url: string, opts: { headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; raw?: boolean } = {}): Promise<Called> {
  try {
    let res = await i.call({ method, url, headers: { ...auth, ...(opts.headers || {}) }, body: opts.body, timeoutMs: opts.timeoutMs })
    if (res.status === 401 && auth.Authorization) {
      // The cached access token may simply have expired early: mint a fresh one once, then believe the answer.
      forgetAccessToken(i.connection.id)
      let refresh = ''
      try { refresh = JSON.parse(decryptSecret(i.connection.credentials_enc || '', `${i.connection.workspace_id}:${i.connection.id}`)).refresh_token } catch { /* falls through to the 401 verdict */ }
      const t = refresh ? await accessToken(i.connection.id, refresh, i.call, i.env || process.env) : null
      if (t && t.ok) { auth.Authorization = `Bearer ${t.token}`; res = await i.call({ method, url, headers: { ...auth, ...(opts.headers || {}) }, body: opts.body, timeoutMs: opts.timeoutMs }) }
    }
    return { verdict: classifyGoogle(res), json: res.json, location: res.location }
  } catch (e: any) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    return { verdict: { outcome: 'retry', error: timeout ? 'Google did not answer in time.' : `Could not reach Google: ${e?.message || e}` }, json: null, location: null }
  }
}

// ── folders ──────────────────────────────────────────────────────────────────
async function ensureFolders(i: DriveCtx, auth: Record<string, string>, levels: Array<{ key: string; name: string }>): Promise<{ leaf: string } | { verdict: GoogleVerdict }> {
  let parent: string | null = null
  for (const level of levels) {
    const known = await findRef(i, 'folder', level.key)
    if (known === 'error') return { verdict: { outcome: 'retry', error: 'Could not read archive records.' } }
    if (known) { parent = known.remote_id; continue }

    // Not recorded: it may exist from an attempt that died before recording it.
    const q = `appProperties has { key='scopegov_key' and value='${level.key}' } and mimeType='${FOLDER_MIME}' and trashed=false`
    const found = await call(i, auth, 'GET', `${DRIVE_FILES_URL}?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1', spaces: 'drive' })}`)
    if (found.verdict.outcome !== 'ok') return { verdict: found.verdict }
    let id: string | undefined = found.json?.files?.[0]?.id
    if (!id) {
      const made = await call(i, auth, 'POST', `${DRIVE_FILES_URL}?fields=id`, {
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ name: level.name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}), appProperties: { scopegov_key: level.key } }),
      })
      if (made.verdict.outcome !== 'ok') return { verdict: made.verdict }
      id = made.json?.id
    }
    if (typeof id !== 'string') return { verdict: { outcome: 'retry', error: 'Google did not return a folder id.' } }
    await saveRef(i, 'folder', level.key, id, level.name, null)
    parent = id
  }

  // Verify the LEAF is alive: a folder trashed (or deleted) in Drive still accepts uploads — invisibly. Trashing a parent
  // marks its children trashed too, so checking the deepest folder covers the chain.
  const leaf = parent as string
  const check = await call(i, auth, 'GET', `${DRIVE_FILES_URL}/${encodeURIComponent(leaf)}?fields=id,trashed`)
  if (check.verdict.outcome !== 'ok') return { verdict: check.verdict }
  if (check.json?.trashed) return { verdict: { outcome: 'folder_gone', error: 'The archive folder is in the Drive trash.' } }
  return { leaf }
}

// ── refs ─────────────────────────────────────────────────────────────────────
async function findRef(i: DriveCtx, type: 'folder' | 'file', key: string): Promise<{ remote_id: string; remote_url: string | null } | null | 'error'> {
  const { data, error } = await i.service.from('integration_external_refs').select('remote_id, remote_url')
    .eq('connection_id', i.connection.id).eq('ref_type', type).eq('local_key', key).maybeSingle()
  if (error) { console.error('[drive] ref lookup failed:', error.message); return 'error' }
  return data || null
}
async function saveRef(i: DriveCtx, type: 'folder' | 'file', key: string, remoteId: string, name: string, url: string | null) {
  const { error } = await i.service.from('integration_external_refs').insert({
    workspace_id: i.connection.workspace_id, connection_id: i.connection.id, ref_type: type, local_key: key, remote_id: remoteId, remote_name: name, remote_url: url,
  })
  // A concurrent delivery got there first: its record stands, ours would only be a duplicate. Anything else is worth a log.
  if (error && (error as any).code !== '23505') console.error('[drive] could not record archive ref:', error.message)
}
async function purgeFolderRefs(i: DriveCtx) {
  const { error } = await i.service.from('integration_external_refs').delete().eq('connection_id', i.connection.id).eq('ref_type', 'folder')
  if (error) console.error('[drive] could not clear folder refs:', error.message)
}

/**
 * Make sure the archive's root folder exists and is alive, returning its id. Used when Drive is connected, so a setup problem
 * (most often: the Drive API is not enabled for the Google Cloud project) shows up immediately instead of when the first
 * contract is signed days later.
 */
export async function ensureArchiveRoot(i: DriveCtx, accessTokenValue: string, retried = false): Promise<{ id: string; url: string } | { verdict: GoogleVerdict }> {
  const r = await ensureFolders(i, { Authorization: `Bearer ${accessTokenValue}` }, [{ key: `root:${i.connection.workspace_id}`, name: ARCHIVE_ROOT_NAME }])
  if ('verdict' in r) {
    if (r.verdict.outcome === 'folder_gone' && !retried) { await purgeFolderRefs(i); return ensureArchiveRoot(i, accessTokenValue, true) }
    if (r.verdict.outcome === 'folder_gone') return { verdict: { outcome: 'retry', error: r.verdict.error } }
    return r
  }
  return { id: r.leaf, url: `https://drive.google.com/drive/folders/${encodeURIComponent(r.leaf)}` }
}
