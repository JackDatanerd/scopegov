import type { MetadataRoute } from 'next'

// Public, signed-out pages only. Keep in sync with isPublicRoute in middleware.ts and the Disallow rules in public/robots.txt.
// (Client-portal links are tokenised and private, so they are deliberately not listed.)
const BASE = 'https://www.scopegov.app'

export default function sitemap(): MetadataRoute.Sitemap {
  const paths: { path: string; priority: number; changeFrequency: 'weekly' | 'monthly' | 'yearly' }[] = [
    { path: '/', priority: 1, changeFrequency: 'weekly' },
    { path: '/calculator', priority: 0.8, changeFrequency: 'monthly' },
    { path: '/signup', priority: 0.7, changeFrequency: 'monthly' },
    { path: '/login', priority: 0.3, changeFrequency: 'yearly' },
    { path: '/legal/privacy', priority: 0.3, changeFrequency: 'yearly' },
    { path: '/legal/terms', priority: 0.3, changeFrequency: 'yearly' },
    { path: '/legal/dpa', priority: 0.3, changeFrequency: 'yearly' },
    { path: '/legal/security', priority: 0.3, changeFrequency: 'yearly' },
    { path: '/legal/cookies', priority: 0.3, changeFrequency: 'yearly' },
  ]
  return paths.map((p) => ({ url: `${BASE}${p.path === '/' ? '' : p.path}`, changeFrequency: p.changeFrequency, priority: p.priority }))
}
