import { getSession } from '@/lib/auth/session'
import { permissionsRequireMfa } from '@/lib/auth/mfa-policy'
import { redirect } from 'next/navigation'
import MfaSetupClient from '@/components/mfa/MfaSetupClient'

interface Props {
  searchParams: Promise<{ next?: string; recovered?: string }>
}

export default async function MfaSetupPage({ searchParams }: Props) {
  const session = await getSession()
  if (!session) redirect('/login')

  const sp = await searchParams
  const mandatory = permissionsRequireMfa(session.permissions)

  return (
    <MfaSetupClient
      mandatory={mandatory}
      next={sp.next || '/dashboard'}
      recovered={sp.recovered === '1'}
      userName={session.name}
    />
  )
}
