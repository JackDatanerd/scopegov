// lib/utils/seat-limit.ts
//
// FIX (deep audit, section 6 — flagship finding): the plan's seat limit
// was only ever enforced at ONE point — POST /api/team/invite, before
// creating a new invited row. Every other place a workspace_members row
// actually becomes 'active' had no equivalent check at all:
//
//   - api/team/invite/[token]/accept/route.ts   (existing user accepts)
//   - api/team/invite/[token]/signup/route.ts   (new user accepts)
//   - api/team/[id]/route.ts PATCH status:'active' (reactivating a
//     deactivated member)
//
// That's trivially reachable with no external trickery at all: on a
// 2-seat plan, deactivate a member, invite+accept a replacement (2/2
// active again), then reactivate the first one — 3 active members on a
// 2-seat plan, nothing anywhere objects. It's also reachable passively:
// invite up to the seat+invited cap on a higher tier, downgrade (the
// self-service downgrade check in api/billing/upgrade only ever counts
// `status = 'active'`, never `'invited'`), and let the still-pending
// invites accept normally afterwards.
//
// One shared check, parameterized by which statuses count toward the
// limit, so invite-creation (which reserves a seat for a pending invite
// too) and activation (which only cares about members who are actually
// live) share the same source of truth instead of drifting into three
// slightly-different inline queries.
import { PLAN_LIMITS } from '@/lib/utils/format'

export type SeatLimitResult = { ok: true } | { ok: false; message: string }

async function countSeats(
  service: any, workspaceId: string, countedStatuses: string[]
): Promise<{ count: number; error: any }> {
  const nowIso = new Date().toISOString()
  const settled = countedStatuses.filter(st => st !== 'invited')
  let count = 0
  let error: any = null
  if (settled.length > 0) {
    const r = await service.from('workspace_members')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).in('status', settled)
    error = r.error; count += r.count || 0
  }
  // A pending invite only holds a seat until it lapses: an expired-but-not-yet-flipped invite (the
  // daily cron hasn't run) holds none, and the Team page already lists it under Expired.
  if (!error && countedStatuses.includes('invited')) {
    const r = await service.from('workspace_members')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'invited')
      .or(`invite_token_expires_at.is.null,invite_token_expires_at.gt.${nowIso}`)
    error = r.error; count += r.count || 0
  }
  return { count, error }
}

export async function checkSeatLimit(
  service: any,
  workspaceId: string,
  planTier: string,
  countedStatuses: string[]
): Promise<SeatLimitResult> {
  const limits = PLAN_LIMITS[planTier]
  if (!limits?.seats) return { ok: true }

  const { count, error } = await countSeats(service, workspaceId, countedStatuses)
  if (error) {
    console.error('Seat limit check failed (failing open):', error)
    return { ok: true }
  }

  if (count >= limits.seats) {
    return { ok: false, message: seatLimitMessage(limits) }
  }
  return { ok: true }
}

function seatLimitMessage(limits: { seats: number; name: string }) {
  return `This workspace is at its ${limits.seats}-seat limit on the ${limits.name} plan. Deactivate a member or upgrade in Settings \u2192 Billing first.`
}

/**
 * FIX (Team & Invites independent pass — H1): checkSeatLimit is a read followed, some milliseconds
 * later, by a write, and nothing serializes the two — two admins inviting (or reactivating, or
 * reviving an expired invite) at the same moment with one seat left both read "room for one" and
 * both write, leaving the workspace one over its plan. The seat-CONSUMING writes (invite creation,
 * reactivation, re-issuing an expired invite) call this AFTER their write lands: the count now
 * includes the caller's own row, so more than `seats` means the caller lost the race and must undo
 * its own write. Two simultaneous writers can both undo (each sees the other's row) — that fails
 * closed and is retryable, which is the right side to err on for a paid limit. Accepting an invite
 * needs none of this: it converts a seat the invite already reserved, so the total never moves.
 * Like checkSeatLimit it fails open on a query error.
 */
export async function seatLimitBreachedAfterWrite(
  service: any,
  workspaceId: string,
  planTier: string,
  countedStatuses: string[]
): Promise<SeatLimitResult> {
  const limits = PLAN_LIMITS[planTier]
  if (!limits?.seats) return { ok: true }
  const { count, error } = await countSeats(service, workspaceId, countedStatuses)
  if (error) {
    console.error('Post-write seat limit check failed (failing open):', error)
    return { ok: true }
  }
  if (count > limits.seats) return { ok: false, message: seatLimitMessage(limits) }
  return { ok: true }
}
