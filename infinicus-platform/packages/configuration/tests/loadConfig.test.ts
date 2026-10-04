import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigurationError } from '../src/index.js';

describe('loadConfig', () => {
  it('loads a valid config from a full environment', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x', NODE_ENV: 'production', PORT: '4000', DB_SSL: 'true' });
    expect(config).toEqual({
      env: 'production',
      databaseUrl: 'postgresql://x',
      dbSsl: true,
      port: 4000,
      logLevel: 'info',
      rateLimitMax: 100,
      rateLimitWindowMs: 60_000,
      dbPoolMin: 2,
      dbPoolMax: 10,
      dbIdleTimeoutMs: 30_000,
      dbConnectionTimeoutMs: 5_000,
      dbStatementTimeoutMs: 30_000,
      corsAllowedOrigins: ['https://infini-cus.com', 'https://www.infini-cus.com'],
    });
  });

  it('defaults corsAllowedOrigins to the live site\'s domain when unset', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x' });
    expect(config.corsAllowedOrigins).toEqual(['https://infini-cus.com', 'https://www.infini-cus.com']);
  });

  it('respects a CORS_ALLOWED_ORIGINS override, trimming whitespace and dropping empty entries', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x', CORS_ALLOWED_ORIGINS: ' https://staging.example.com, http://localhost:3001 ,' });
    expect(config.corsAllowedOrigins).toEqual(['https://staging.example.com', 'http://localhost:3001']);
  });

  it('throws ConfigurationError when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigurationError);
  });

  it('defaults env to development for an unrecognized NODE_ENV', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x', NODE_ENV: 'weird' });
    expect(config.env).toBe('development');
  });

  it('defaults env to development when NODE_ENV is unset', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x' });
    expect(config.env).toBe('development');
  });

  it('defaults logLevel to debug outside production', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x', NODE_ENV: 'development' });
    expect(config.logLevel).toBe('debug');
  });

  it('respects an explicit LOG_LEVEL override', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x', LOG_LEVEL: 'warn' });
    expect(config.logLevel).toBe('warn');
  });

  it('applies default port, rateLimitMax, and rateLimitWindowMs when unset', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x' });
    expect(config.port).toBe(3000);
    expect(config.rateLimitMax).toBe(100);
    expect(config.rateLimitWindowMs).toBe(60_000);
  });

  it('throws ConfigurationError for a non-numeric PORT', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://x', PORT: 'not-a-number' })).toThrow(ConfigurationError);
  });

  it('respects RATE_LIMIT_MAX and RATE_LIMIT_WINDOW_MS overrides', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x', RATE_LIMIT_MAX: '50', RATE_LIMIT_WINDOW_MS: '30000' });
    expect(config.rateLimitMax).toBe(50);
    expect(config.rateLimitWindowMs).toBe(30_000);
  });

  it('applies default connection-pool settings when unset', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://x' });
    expect(config.dbPoolMin).toBe(2);
    expect(config.dbPoolMax).toBe(10);
    expect(config.dbIdleTimeoutMs).toBe(30_000);
    expect(config.dbConnectionTimeoutMs).toBe(5_000);
    expect(config.dbStatementTimeoutMs).toBe(30_000);
  });

  it('respects connection-pool overrides', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://x',
      DB_POOL_MIN: '5', DB_POOL_MAX: '25',
      DB_IDLE_TIMEOUT_MS: '10000', DB_CONNECTION_TIMEOUT_MS: '2000', DB_STATEMENT_TIMEOUT_MS: '15000',
    });
    expect(config.dbPoolMin).toBe(5);
    expect(config.dbPoolMax).toBe(25);
    expect(config.dbIdleTimeoutMs).toBe(10_000);
    expect(config.dbConnectionTimeoutMs).toBe(2_000);
    expect(config.dbStatementTimeoutMs).toBe(15_000);
  });

  it('throws ConfigurationError for a non-numeric DB_POOL_MAX', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://x', DB_POOL_MAX: 'not-a-number' })).toThrow(ConfigurationError);
  });

  it('refuses to start in production when DATABASE_URL looks like a local/test credential (BUILD-24)', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://infinicus_test_admin:local_admin_pw@localhost:5432/infinicus_test',
      })
    ).toThrow(ConfigurationError);
  });

  it('allows production to start with a DATABASE_URL that does not match any local/test pattern (BUILD-24)', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://prod_app_role:x9k2m@prod-db.internal:5432/infinicus_production',
        DB_SSL: 'true',
      })
    ).not.toThrow();
  });

  it('does not apply the production-credential guard outside production (BUILD-24)', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://infinicus_test_admin:local_admin_pw@localhost:5432/infinicus_test',
      })
    ).not.toThrow();
  });

  describe('dbSsl resolution', () => {
    it('respects an explicit DB_SSL=true', () => {
      const config = loadConfig({ DATABASE_URL: 'postgresql://x', DB_SSL: 'true' });
      expect(config.dbSsl).toBe(true);
    });

    it('respects an explicit DB_SSL=false, even for a non-localhost host (regression: Docker Compose outage)', () => {
      const config = loadConfig({ DATABASE_URL: 'postgresql://postgres:5432/infinicus', DB_SSL: 'false' });
      expect(config.dbSsl).toBe(false);
    });

    it('accepts "1" and "0" as well as "true"/"false"', () => {
      expect(loadConfig({ DATABASE_URL: 'postgresql://x', DB_SSL: '1' }).dbSsl).toBe(true);
      expect(loadConfig({ DATABASE_URL: 'postgresql://x', DB_SSL: '0' }).dbSsl).toBe(false);
    });

    it('throws ConfigurationError in production when DB_SSL is unset — no longer silently guessed', () => {
      expect(() =>
        loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://prod-db.internal/infinicus' })
      ).toThrow(ConfigurationError);
    });

    it('throws ConfigurationError in staging when DB_SSL is unset', () => {
      expect(() =>
        loadConfig({ NODE_ENV: 'staging', DATABASE_URL: 'postgresql://staging-db.internal/infinicus' })
      ).toThrow(ConfigurationError);
    });

    it('falls back to the hostname heuristic in development when DB_SSL is unset', () => {
      const local = loadConfig({ DATABASE_URL: 'postgresql://localhost:5432/infinicus' });
      expect(local.dbSsl).toBe(false);

      const remote = loadConfig({ DATABASE_URL: 'postgresql://some-host:5432/infinicus' });
      expect(remote.dbSsl).toBe(true);
    });

    it('falls back to the hostname heuristic in test when DB_SSL is unset', () => {
      const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost:5432/infinicus_test' });
      expect(config.dbSsl).toBe(false);
    });
  });
});
