export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

export class AccountNotActiveError extends Error {
  constructor(status: string) {
    super(`Account is not active (status: ${status})`);
    this.name = 'AccountNotActiveError';
  }
}

/** Thrown by AuthenticationService.login() when the account has too many recent failed-password attempts. Never thrown for an unknown email (see AccessEventRepository.countRecentFailedPasswordAttempts's own doc comment for why). */
export class AccountLockedError extends Error {
  constructor(retryAfterMs: number) {
    super(`Account temporarily locked after too many failed login attempts. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = 'AccountLockedError';
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super('Session has expired');
    this.name = 'SessionExpiredError';
  }
}

export class SessionRevokedError extends Error {
  constructor() {
    super('Session has been revoked');
    this.name = 'SessionRevokedError';
  }
}

export class SessionInvalidError extends Error {
  constructor() {
    super('Session token is invalid or unknown');
    this.name = 'SessionInvalidError';
  }
}

export class ApiKeyInvalidError extends Error {
  constructor() {
    super('API key is invalid, expired, or revoked');
    this.name = 'ApiKeyInvalidError';
  }
}

export class WeakPasswordError extends Error {
  constructor(reasons: readonly string[]) {
    super(`Password does not meet minimum requirements: ${reasons.join(', ')}`);
    this.name = 'WeakPasswordError';
  }
}

export class VerificationTokenInvalidError extends Error {
  constructor() {
    super('Email verification token is invalid, expired, or already used');
    this.name = 'VerificationTokenInvalidError';
  }
}
