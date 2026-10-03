// lib/admin/page-guard.ts
//
// Per-page guard for the Server Components under app/(admin)/admin/*.
//
// FIX (Admin panel independent audit — B1, HIGH): the only check was in app/(admin)/admin/layout.tsx. In the
// App Router a layout and its page are rendered in parallel, and a layout's redirect() does NOT stop the page's
// own data fetching or keep its payload out of an RSC response (Next documents this: "do not do auth checks in
// layouts"). Four of these pages read cross-tenant data with the service-role client, so any signed-in
// non-admin could be handed billing rows, admin e-mails and IPs. Every server page now calls this FIRST, before
// it creates a service client.
import { redirect } from 'next/navigation'
import { getAdminActor, adminNeedsMfaEnrolment, type AdminActor } from '@/lib/auth/admin'

export async function requireAdminPage(): Promise<AdminActor> {
  const actor = await getAdminActor()
  if (actor) return actor
  // A confirmed platform admin who has not enrolled a factor yet is sent to set one up; everyone else gets the
  // same silent redirect so the surface's existence stays hidden.
  if (await adminNeedsMfaEnrolment()) redirect('/mfa-setup?next=%2Fadmin')
  redirect('/dashboard')
}
