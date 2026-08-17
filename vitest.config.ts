import { defineConfig } from 'vitest/config'
import path from 'node:path'

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
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
