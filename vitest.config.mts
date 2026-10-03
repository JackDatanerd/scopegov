import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// .mts so Vite loads this as native ESM (no CJS-loader warning); __dirname does not exist in ESM.
const root = path.dirname(fileURLToPath(import.meta.url))

// FIX (re-audit): this repo had no test infrastructure at all — no
// vitest config, no vitest dependency, no test files, and no
// test-related commit in the entire git history, despite prior audit
// notes referencing an established "42-test vitest suite" (that work
// either never got pushed to this repo or was lost — not something to
// guess-reconstruct after the fact). This scaffolds real vitest
// infrastructure and `tests/` covers the pure-logic modules plus
// regression coverage for the race-condition fixes made in this audit
// pass. It's a starting point, not a claim of full coverage — most of
// this codebase's actual risk lives in Supabase-backed route handlers,
// which need integration-style tests against a real (or properly
// mocked) Postgres/PostgREST, not unit tests against a hand-rolled
// client mock.
export default defineConfig({
  // tsconfig has jsx:'preserve' (Next compiles JSX itself); tests that execute .tsx modules need it transformed.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts'],
    // Route tests dynamically import real route modules; the first import in a file has to transform the
    // whole module graph, which takes 5-7s on a cold cache when ~230 files run in parallel (Windows/Defender
    // makes it worse). The 5s default made those tests flaky-fail with "Test timed out in 5000ms".
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(root, '.'),
    },
  },
})
