'use client'
import { useParams } from 'next/navigation'
import CoEditor from '@/components/co/CoEditor'

export default function CoDetailPage() {
  const params = useParams()
  return <CoEditor projId={params.id as string} coId={params.coId as string} />
}
