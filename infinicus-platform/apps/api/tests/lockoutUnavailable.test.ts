import { describe, expect, it } from 'vitest';
import { LockoutStateUnavailableError } from '@infinicus/authentication';
import { statusCodeFor } from '../src/errors.js';

describe('AUTH-LOCKOUT-1 HTTP contract', () => {
  it('maps the controlled lockout-state dependency failure to HTTP 503 without sensitive details', () => {
    const error = new LockoutStateUnavailableError();
    expect(statusCodeFor(error.name)).toBe(503);
    expect(error.message).toBe('Password login is temporarily unavailable. Please try again later.');
    expect(error.message).not.toMatch(/password=|postgresql:\/\/|database_url/i);
  });
});
