# Writing help articles for ScopeGov

The reference article is `lib/help/articles/first-project.ts`. **Read it first and copy its shape, length and voice.**
You write content; `components/help/HelpArticleView.tsx` does the layout, so every article looks the same.

## Add an article (3 steps)

1. Create `lib/help/articles/<slug>.ts` exporting a `HelpArticle` (type in `lib/help/types.ts`).
2. Import it in `lib/help/index.ts` and add it to `ARTICLES`.
3. Run `npx tsc --noEmit` and `npx vitest run tests/help-articles.test.ts tests/help-render.test.ts`.

The Help home page, the `/help/<slug>` route and the tests pick it up automatically. Do not edit pages or CSS.

## Categories (`lib/help/categories.ts`)

getting-started, clients-projects, sow, change-orders, invoicing, guardian, approvals, team-permissions,
billing-plans, integrations-security. A category appears on the Help home page once it has an article.

## The template (every field is required unless marked optional)

| Field | What goes in it |
|---|---|
| `title` | The reader's words ("Why can't I send my SOW?"), not the feature name |
| `summary` | One sentence: what the reader will be able to do |
| `audience` | `permissions` needed (empty = any member) and lowest `plan` (`'all'` or a paid plan) |
| `shortAnswer` | 2-3 sentences, the whole article in miniature |
| `beforeYouStart` | Optional. Things to have ready |
| `steps` | Ordered. Each: `title`, `body` (one short paragraph), optional `details` bullets, optional single `watchFor`, optional `minutes` |
| `dos` / `donts` | 3-4 each, concrete |
| `problems` | "If you see X (`symptom`), it means Y (`meaning`), do Z (`fix`)" |
| `whatHappensNext` | So nothing feels irreversible or mysterious |
| `related` | Slugs of other **published** articles (the test checks they exist) |
| `updated` | ISO date you last checked the article against the product |

## Rules

- **Labels must be exact.** Every button, tab and field name is copied from the code, not remembered. Wrap them in `**bold**`.
  Search the codebase for the string before using it. If a label is ambiguous (the SOW tab says **Sent**, the Overview says
  "Awaiting signature"), use the one on the screen the reader is on.
- **Only claim what the code does.** If you cannot point to the line that does it, leave it out or ask.
- **Short.** One idea per sentence. No history, no marketing. If a step needs more than a paragraph and four bullets, split the article.
- **Say who and what plan** in `audience`. "I can't see X" tickets are mostly permission or plan; the strip at the top answers them.
- **Explain consequences, not just clicks.** What does the client see? Can it be undone? What does it change later (tax, Guardian, invoices)?
- **Voice:** second person, plain, calm. "Click **Send to client**." Not "the user should navigate to...".
- **Inline markup is only** `**UI label**` and `[Page name](/in-app/path)`. No HTML, no external links.
- **Link to other articles through `related`,** not inline, so the test can verify they exist.
- Numbers that live in code (plan limits, prices, expiry days) must match the code. Plan facts come from `lib/billing/entitlements.ts`.
- Re-check labels and bump `updated` whenever the screen an article describes changes.

## Pasting this into a new chat

> Write the next help article for ScopeGov: "<title>". Read `lib/help/AUTHORING.md` and `lib/help/articles/first-project.ts`
> first and match them exactly. Verify every UI label and every claim against the code. Add it to `lib/help/index.ts`,
> run tsc and the help tests, and deliver it as a tarball in our usual workflow.

## Search (how readers find your article)

The Help home page has a search box (`lib/help/search.ts`). It reads, strongest first: the **title**, each problem's **symptom**, the button and field names you wrote in `**bold**`, the **summary**, the **step titles** and the **short answer**.

- Write titles and symptoms the way a stuck person would type them ("I can't find the Send button"), not as feature names.
- Wrap every real button, tab and field name in `**bold**`. It is what makes "send to client" or "copy signing link" find your article.
- `tests/help-search.test.ts` enforces this for every article: typing its exact title must return it first, and typing any of its symptoms must surface it in the top 5. A new article that cannot be found fails the suite.
- If readers use a word your article does not (for example "2FA" for "two-factor"), add it to `SYNONYMS` in `lib/help/search.ts`.
