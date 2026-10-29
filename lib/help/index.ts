// lib/help/index.ts
// The article registry. To publish an article: create lib/help/articles/<slug>.ts, import it here, add it to ARTICLES.
// Nothing else needs touching: the Help home page, the article route, the command palette and the tests all read from here.

import { HELP_CATEGORIES } from './categories'
import { firstProject } from './articles/first-project'
import type { HelpArticle, HelpCategory } from './types'

export const ARTICLES: HelpArticle[] = [
  firstProject,
]

export function getArticle(slug: string): HelpArticle | null {
  return ARTICLES.find(a => a.slug === slug) ?? null
}

export function getCategory(id: string): HelpCategory | null {
  return HELP_CATEGORIES.find(c => c.id === id) ?? null
}

/** Categories that have at least one article, in display order, each with its articles sorted by `order`. */
export function groupedArticles(): Array<{ category: HelpCategory; articles: HelpArticle[] }> {
  return HELP_CATEGORIES
    .map(category => ({
      category,
      articles: ARTICLES.filter(a => a.category === category.id).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
    }))
    .filter(g => g.articles.length > 0)
}

export function relatedArticles(article: HelpArticle): HelpArticle[] {
  return article.related.map(getArticle).filter((a): a is HelpArticle => a !== null)
}
