import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import MarketingHome from '@/components/marketing/MarketingHome'

export const metadata: Metadata = {
  title: { absolute: 'ScopeGov — 83% of change orders get approved' },
  description: 'Guardian reads every client email against your signed Statement of Work, flags what is out of scope, and drafts the change order. 45,000+ SOWs, 30,000+ change orders, $36M recovered.',
}

export default async function RootPage() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (user) redirect('/dashboard')
  return <MarketingHome />
}
