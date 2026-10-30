// The ONE canonical public origin. The same deployment answers on www., app. and sign. — only www. is the marketing
// site that search engines should index. Every canonical URL, the sitemap and robots.txt's Sitemap line point here.
// (app/layout.tsx's metadataBase and public/robots.txt carry the same literal; tests/seo-indexing.test.ts keeps them equal.)
export const SITE_URL = 'https://www.scopegov.app'
