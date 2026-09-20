// app/(app)/notifications/page.tsx
//
// FEATURE (Notifications & email fix round): the bell was the only place notifications lived and
// it only ever showed the latest 50, with no way to see older ones, filter, or remove any.
import { getSession } from '@/lib/auth/session'
import { redirect } from 'next/navigation'
import NotificationsClient from '@/components/notifications/NotificationsClient'

export const metadata = { title: 'Notifications' }

export default async function NotificationsPage() {
  const session = await getSession()
  if (!session) redirect('/login')
  return <NotificationsClient />
}
