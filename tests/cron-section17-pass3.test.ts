// tests/cron-section17-pass3.test.ts
//
// Regression guards for the section-17 (cron) independent pass 3:
//   B1 — erase_user_pii left workspace_members.invited_email (the real address) behind (migration 121)
//   B2 — project-purge / workspace-purge wrote an ok:false AND an ok:true cron_run_history row for one partial-failure run
// Source-level checks (the behavioural check for B1 is in tests/pg-replay.test.ts, which needs PG_REPLAY_URL).

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.join(__dirname, '..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')

describe('cron section 17, pass 3', () => {
  it('B1: migration 121 makes erase_user_pii null invited_email and backfills already-erased users', () => {
    const sql = read('supabase/migrations/121_erase_user_pii_invited_email.sql')
    expect(sql).toMatch(/UPDATE public\.workspace_members\s+SET invited_email = NULL\s+WHERE user_id = p_user_id/)
    expect(sql).toMatch(/'invited_emails', v_invited/)
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.erase_user_pii\(uuid, text\) FROM PUBLIC, anon, authenticated/)
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.erase_user_pii\(uuid, text\) TO service_role/)
    expect(sql).toMatch(/u\.email LIKE 'deleted-%@deleted\.scopegov\.app'/)
    // still the 075 behaviour: audit + notifications + identities
    for (const needle of ['public.audit_log', 'public.notifications', 'auth.identities']) expect(sql).toContain(needle)
  })

  for (const name of ['project-purge', 'workspace-purge']) {
    it(`B2: ${name} partial-failure alert does not add its own failed history row`, () => {
      const src = read(`app/api/cron/${name}/route.ts`)
      const call = src.slice(src.indexOf(`alertCronFailure(service, '${name}', new Error(`))
      expect(call.slice(0, 500)).toMatch(/undefined,\s*\{\s*history:\s*false\s*\}/)
      // the run is still recorded once, by the heartbeat, with the failure count in its result
      expect(src).toMatch(/recordCronHeartbeat\(service, '[a-z-]+', \{ purged: purgedCount, failed: failures\.length \}\)/)
    })
  }
})
