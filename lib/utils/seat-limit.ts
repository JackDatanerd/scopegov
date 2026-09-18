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

export async function checkSeatLimit(
  service: any,
  workspaceId: string,
  planTier: string,
  countedStatuses: string[]
): Promise<SeatLimitResult> {
  const limits = PLAN_LIMITS[planTier]
  if (!limits?.seats) return { ok: true }

  const { count, error } = await service
    .from('workspace_members')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', countedStatuses)

  // Fail open on a DB error here, same reasoning as checkInviteRateLimit
  // (lib/utils/rate-limit.ts) — a broken seat-count query should never be
  // the thing that locks a real member out of their own account.
  if (error) {
    console.error('Seat limit check failed (failing open):', error)
    return { ok: true }
  }

  if ((count || 0) >= limits.seats) {
    return {
      ok: false,
      message: `This workspace is at its ${limits.seats}-seat limit on the ${limits.name} plan. Deactivate a member or upgrade in Settings \u2192 Billing first.`,
    }
  }
  return { ok: true }
}
