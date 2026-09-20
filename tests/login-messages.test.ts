import { describe, it, expect } from 'vitest'
import { resolveLoginMessage, LOGIN_MESSAGES } from '@/lib/auth/login-messages'

// /login used to render ANY ?message= text in the green success box.
describe('resolveLoginMessage', () => {
  it('resolves known codes', () => {
    expect(resolveLoginMessage('account_deleted')).toEqual(LOGIN_MESSAGES.account_deleted)
    expect(resolveLoginMessage('link_invalid')?.tone).toBe('error')
  })

  it('ignores unknown codes and arbitrary attacker-supplied text', () => {
    expect(resolveLoginMessage('nope')).toBeNull()
    expect(resolveLoginMessage(null, 'Your account is locked. Call +1 555 0100 to unlock.')).toBeNull()
    expect(resolveLoginMessage('__proto__')).toBeNull()
    expect(resolveLoginMessage('constructor')).toBeNull()
    expect(resolveLoginMessage('toString')).toBeNull()
  })

  it('still honours the exact legacy strings this app used to emit (links in flight)', () => {
    expect(resolveLoginMessage(null, 'Account deleted.')).toEqual(LOGIN_MESSAGES.account_deleted)
    expect(resolveLoginMessage(null, 'Password updated. Please sign in again.')).toEqual(LOGIN_MESSAGES.password_updated)
    expect(resolveLoginMessage(null, 'Workspace deleted.')).toEqual(LOGIN_MESSAGES.workspace_deleted)
  })

  it('does not honour near-miss legacy strings', () => {
    expect(resolveLoginMessage(null, 'Account deleted. Click here')).toBeNull()
  })
})
