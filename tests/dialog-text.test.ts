import { describe, it, expect } from 'vitest'
import { splitMessage, confirmLabel, confirmTone, alertTone } from '@/lib/ui/dialog-text'

describe('legacy dialog messages become title + body', () => {
  it('splits the question from its consequence', () => {
    expect(splitMessage('Delete "Acme"? This can\'t be undone.', 'Please confirm')).toEqual({ title: 'Delete "Acme"?', paragraphs: ['This can\'t be undone.'] })
  })
  it('keeps every paragraph of a long message', () => {
    const r = splitMessage('Approved. The email could not be sent.\n\nThe requester can retry.', 'Heads up')
    expect(r.title).toBe('Approved')
    expect(r.paragraphs).toEqual(['The email could not be sent.', 'The requester can retry.'])
  })
  it('a single long sentence goes under the fallback title unchanged', () => {
    const long = 'The Deliverables table gives "Account or system access" one Client date but Assumptions give a different date for related work.'
    expect(splitMessage(long, 'Please confirm')).toEqual({ title: 'Please confirm', paragraphs: [long] })
  })
  it('an empty message still has a title', () => {
    expect(splitMessage('', 'Heads up')).toEqual({ title: 'Heads up', paragraphs: [] })
  })
})

describe('button label and tone follow the action', () => {
  it('names the action', () => {
    expect(confirmLabel('Delete "X"? This can\'t be undone.')).toBe('Delete')
    expect(confirmLabel('Send this invoice to the client now?')).toBe('Send')
    expect(confirmLabel('Make "Admin" the default role?')).toBe('Make default')
    expect(confirmLabel('Cancel your subscription?')).toBe('Yes, cancel')
    expect(confirmLabel('AI drafting will replace your notes. Continue?')).toBe('Confirm')
  })
  it('destructive wording is red, the rest is neutral', () => {
    expect(confirmTone('Delete this draft invoice? This cannot be undone.')).toBe('danger')
    expect(confirmTone('Restore "X"? It will come back as it was.')).toBe('default')
  })
  it('alerts are classified by what they say', () => {
    expect(alertTone('Could not reach the server.')).toBe('error')
    expect(alertTone('Reminder sent.')).toBe('success')
    expect(alertTone('The SOW is withdrawn, but the email was not sent. You may want to let them know.')).toBe('warning')
    expect(alertTone('Sent for approval — the client will be notified.')).toBe('success')
  })
})
