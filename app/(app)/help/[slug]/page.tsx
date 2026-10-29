// app/(app)/help/[slug]/page.tsx
import { notFound } from 'next/navigation'
import HelpArticleView from '@/components/help/HelpArticleView'
import { ARTICLES, getArticle } from '@/lib/help'

export function generateStaticParams() {
  return ARTICLES.map(a => ({ slug: a.slug }))
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  const article = getArticle(params.slug)
  return { title: article ? `${article.title} · Help` : 'Help' }
}

export default function HelpArticlePage({ params }: { params: { slug: string } }) {
  const article = getArticle(params.slug)
  if (!article) notFound()
  return <HelpArticleView article={article} />
}
