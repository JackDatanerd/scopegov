'use client'
import { useParams } from 'next/navigation'
import CoEditor from '@/components/co/CoEditor'

export default function NewCoPage() {
  const params = useParams()
  return <CoEditor projId={params.id as string} coId={undefined} />
}
