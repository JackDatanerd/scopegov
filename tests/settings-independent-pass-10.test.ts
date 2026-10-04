import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

const client = readFileSync('components/settings/SettingsClient.tsx', 'utf8')
const approvalsPage = readFileSync('app/(app)/settings/approvals/page.tsx', 'utf8')

describe('Settings independent pass 10', () => {
  it('Billing cancel and resume report a network failure instead of throwing silently', () => {
    const cancel = client.slice(client.indexOf('async function handleCancel'), client.indexOf('async function handleResume'))
    const resume = client.slice(client.indexOf('async function handleResume'), client.indexOf('async function handleUpdateCard'))
    expect(cancel).toMatch(/catch \{[\s\S]*setCancelError\(/)
    expect(resume).toMatch(/catch \{[\s\S]*setResumeError\(/)
  })

  it('approvals page orders rules like GET /api/approval-workflows, deterministically', () => {
    const q = approvalsPage.slice(approvalsPage.indexOf(".from('approval_workflows')"), approvalsPage.indexOf(".from('roles')"))
    expect(q).toContain(".order('document_type', { ascending: true })")
    expect(q).toContain(".order('threshold_amount', { ascending: false, nullsFirst: false })")
    expect(q).toContain(".order('created_at', { ascending: true })")
    expect(q).toContain(".order('id', { ascending: true })")
  })
})
