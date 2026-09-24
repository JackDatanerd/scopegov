import { describe, it, expect } from 'vitest'
import { collectAttachmentPaths, removeStoragePaths, EVIDENCE_BUCKET } from '@/lib/utils/storage-cleanup'

function fakeService(tables: Record<string, any[] | { error: string }>, removeLog: any[] = [], removeError = false) {
  return {
    from(name: string) {
      const t = tables[name]
      const b: any = {}
      for (const m of ['select', 'eq', 'order']) b[m] = () => b
      b.range = (from: number, to: number) => {
        if (t && !Array.isArray(t)) return Promise.resolve({ data: null, error: { message: t.error } })
        const rows = (t as any[]) || []
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null, count: rows.length })
      }
      return b
    },
    storage: {
      from(bucket: string) {
        return {
          remove: async (paths: string[]) => {
            removeLog.push({ bucket, paths })
            return removeError ? { error: { message: 'nope' } } : { error: null }
          },
        }
      },
    },
  }
}

describe('collectAttachmentPaths', () => {
  it('gathers paths from SOW, CO and flag attachments and de-duplicates', async () => {
    const svc = fakeService({
      sow_attachments: [{ id: '1', storage_path: 'a/1.pdf' }],
      co_attachments: [{ id: '2', storage_path: 'b/2.png' }, { id: '3', storage_path: 'a/1.pdf' }],
      flag_attachments: [{ id: '4', storage_path: 'c/3.jpg' }, { id: '5', storage_path: '' }],
    })
    const paths = await collectAttachmentPaths(svc, { projectId: 'p' })
    expect(paths.sort()).toEqual(['a/1.pdf', 'b/2.png', 'c/3.jpg'])
  })

  it('throws (so the purge is skipped) when any lookup fails', async () => {
    const svc = fakeService({ sow_attachments: [], co_attachments: { error: 'db down' }, flag_attachments: [] })
    await expect(collectAttachmentPaths(svc, { workspaceId: 'w' })).rejects.toThrow(/db down/)
  })
})

describe('removeStoragePaths', () => {
  it('removes in chunks from the evidence bucket', async () => {
    const log: any[] = []
    const paths = Array.from({ length: 250 }, (_, i) => `p/${i}`)
    const r = await removeStoragePaths(fakeService({}, log), paths)
    expect(r).toEqual({ removed: 250, failed: 0 })
    expect(log.length).toBe(3)
    expect(log[0].bucket).toBe(EVIDENCE_BUCKET)
  })

  it('reports failures instead of throwing', async () => {
    const r = await removeStoragePaths(fakeService({}, [], true), ['a', 'b'])
    expect(r).toEqual({ removed: 0, failed: 2 })
  })
})

// ── cron/portal audit round 3: executed SOW/CO PDFs live in the private `pdfs` bucket ──────────────
import { collectExecutedPdfPaths, removePurgedFiles } from '@/lib/utils/storage-cleanup'
import { EXECUTED_PDF_BUCKET } from '@/lib/documents/executed-pdf'

describe('collectExecutedPdfPaths (executed SOW / CO PDFs, migration 061)', () => {
  it('uses the recorded pdf_path, and falls back to the deterministic path for a signed/accepted document whose path was never persisted', async () => {
    const svc = fakeService({
      sow_documents: [
        { id: 's1', workspace_id: 'w1', status: 'signed', pdf_path: 'w1/sow/s1.pdf' },
        { id: 's2', workspace_id: 'w1', status: 'signed', pdf_path: null },      // upload ok, UPDATE lost
        { id: 's3', workspace_id: 'w1', status: 'draft', pdf_path: null },       // never executed: nothing to remove
      ],
      change_orders: [
        { id: 'c1', workspace_id: 'w1', status: 'accepted', pdf_path: null },
        { id: 'c2', workspace_id: 'w1', status: 'declined', pdf_path: null },
      ],
    })
    const paths = await collectExecutedPdfPaths(svc, { projectId: 'p' })
    expect(paths.sort()).toEqual(['w1/co/c1.pdf', 'w1/sow/s1.pdf', 'w1/sow/s2.pdf'])
  })

  it('throws (so the purge is skipped, not run blind) when a lookup fails', async () => {
    const svc = fakeService({ sow_documents: [], change_orders: { error: 'db down' } })
    await expect(collectExecutedPdfPaths(svc, { workspaceId: 'w' })).rejects.toThrow(/db down/)
  })

  it('removePurgedFiles removes evidence from its bucket and executed PDFs from the private pdfs bucket', async () => {
    const log: any[] = []
    const svc = fakeService({}, log)
    const r = await removePurgedFiles(svc, ['e/1.png'], ['w1/sow/s1.pdf'])
    expect(r).toEqual({ removed: 2, failed: 0 })
    expect(log).toEqual([
      { bucket: EVIDENCE_BUCKET, paths: ['e/1.png'] },
      { bucket: EXECUTED_PDF_BUCKET, paths: ['w1/sow/s1.pdf'] },
    ])
  })
})
