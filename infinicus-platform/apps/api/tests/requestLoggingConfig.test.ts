/**
 * CI-HEALTH-1 - the API must not use the deprecated Fastify `disableRequestLogging` option (FSTDEP023, removed in Fastify 6), and per-request log
 * lines must stay disabled. No database is needed: the app is built and inspected, not called.
 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from '@infinicus/configuration';
import { buildApp } from '../src/app.js';

describe('request logging configuration', () => {
  it('building the app emits no FSTDEP023 deprecation warning and keeps request logging disabled', async () => {
    const codes: string[] = [];
    const onWarning = (w: Error & { code?: string }) => { if (w.code) codes.push(w.code); };
    process.on('warning', onWarning);
    const app = await buildApp(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://app_test_user:ci_app_pw@localhost:5432/infinicus_ci' }));
    try {
      await new Promise((resolve) => setImmediate(resolve)); // process warnings are emitted on the next tick
      expect(codes).not.toContain('FSTDEP023');
      const symbol = Object.getOwnPropertySymbols(app).find((s) => s.description === 'fastify.logController');
      expect(symbol, 'the app has a Fastify log controller').toBeDefined();
      const controller = (app as unknown as Record<symbol, { isLogDisabled(req: unknown): boolean }>)[symbol!];
      expect(controller.isLogDisabled({})).toBe(true);
    } finally {
      process.off('warning', onWarning);
      await app.close();
    }
  });
});
