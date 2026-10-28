import { defineConfig } from 'vitest/config';

// These suites run against a live PostgreSQL that the CI job shares with the other packages' tests, which turbo runs in parallel. The default 5 s
// per-test limit is too tight for the multi-step authority/decision tests under that load (one timed out at 5000 ms on a docs-only PR). The limits
// below only bound hangs; no assertion is changed. The API package uses the same approach (apps/api/vitest.config.ts).
export default defineConfig({
  test: {
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
