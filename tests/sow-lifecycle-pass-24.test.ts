import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
const read = (p: string) => fs.readFileSync(p, 'utf8')
describe('SOW lifecycle pass 24', () => {
  it('send fails closed when the live-SOW read fails', () => {
    const src = read('lib/documents/send-sow.ts')
    expect(src).toMatch(/data: liveOthers, error: liveOthersErr/)
    expect(src).toMatch(/if \(liveOthersErr\)/)
  })
  it('msaReference write enforces the approval lock; migration adds opt-in param', () => {
    expect(read('app/api/sow/[id]/route.ts')).toMatch(/p_enforce_approval_lock: true/)
    const sql = read('supabase/migrations/156_sow_metadata_key_approval_lock.sql')
    expect(sql).toMatch(/p_enforce_approval_lock boolean DEFAULT false/)
    expect(sql).toMatch(/approval_requests/)
    expect(read('app/api/portal/sow/[token]/request-changes/route.ts')).not.toMatch(/p_enforce_approval_lock/)
  })
})
