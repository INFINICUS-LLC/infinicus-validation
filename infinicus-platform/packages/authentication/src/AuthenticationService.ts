import {
  UserRepository, SessionRepository, AccessEventRepository, EmailVerificationTokenRepository,
  UserNotFoundError, SessionNotFoundError, EmailVerificationTokenNotFoundError,
  type User, type Session,
} from '@infinicus/database';
import { hashPassword, verifyPassword } from './password.js';
import { generateSessionToken, hashToken, defaultSessionExpiry } from './tokens.js';
import {
  InvalidCredentialsError, AccountNotActiveError, AccountLockedError,
  SessionExpiredError, SessionRevokedError, SessionInvalidError,
  VerificationTokenInvalidError,
} from './errors.js';
import { createEmailSender, resolveEmailConfig, type EmailConfig } from './email/createEmailSender.js';
import type { EmailSender } from './email/EmailSender.js';
import { verificationEmail } from './email/verificationEmail.js';

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Account lockout (BUILD-18 known-limitations: "No account lockout / rate
// limiting" — this closes that gap). 5 bad-password attempts within a
// 15-minute sliding window locks the account; the window naturally clears
// itself as old failures age out, so there is no separate "locked_until"
// state to track or expire.
const LOCKOUT_FAILURE_THRESHOLD = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export interface LoginResult {
  user: User;
  session: Session;
  rawSessionToken: string;
}

export interface ValidatedSession {
  user: User;
  session: Session;
}

export interface RequestMetadata {
  ipAddress?: string;
  userAgent?: string;
}

export class AuthenticationService {
  constructor(
    private readonly users: UserRepository = new UserRepository(),
    private readonly sessions: SessionRepository = new SessionRepository(),
    private readonly accessEvents: AccessEventRepository = new AccessEventRepository(),
    private readonly verificationTokens: EmailVerificationTokenRepository = new EmailVerificationTokenRepository(),
    private readonly emailSender: EmailSender = createEmailSender(),
    private readonly emailConfig: EmailConfig = resolveEmailConfig()
  ) {}

  /**
   * Accounts are activated immediately — signup must not depend on a
   * click-through email step to be usable (this backend previously had no
   * activation route or email-sending capability at all, so a registered
   * account could never actually become usable through the API before
   * this). A real, separate email-ownership-verification flow still
   * exists (see verifyEmail() below) and is tracked via
   * identity.users.email_verified_at, independent of account usability.
   * Sending the verification email is best-effort: a failure here (e.g.
   * no RESEND_API_KEY configured — see NoopEmailSender) must never fail
   * registration, since the account is already fully usable regardless.
   */
  async register(email: string, password: string): Promise<User> {
    const passwordHash = await hashPassword(password);
    const created = await this.users.createUser({ email, passwordHash });
    const active = await this.users.activate(created.id);

    const rawToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
    await this.verificationTokens.create(active.id, hashToken(rawToken), expiresAt);
    await this.emailSender
      .send(verificationEmail(active.email, this.emailConfig.verificationUrlBase, rawToken))
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console -- best-effort send; a failure here must never fail registration (see doc comment above).
        console.warn('[auth] verification email send failed (registration still succeeded)', err);
      });

    return active;
  }

  /** Marks the token's owner's email verified. Does not affect account status/usability — see register()'s own comment. */
  async verifyEmail(rawToken: string): Promise<User> {
    const tokenHash = hashToken(rawToken);
    let token;
    try {
      token = await this.verificationTokens.getByTokenHash(tokenHash);
    } catch (err) {
      if (err instanceof EmailVerificationTokenNotFoundError) throw new VerificationTokenInvalidError();
      throw err;
    }
    if (token.usedAt || token.expiresAt.getTime() < Date.now()) throw new VerificationTokenInvalidError();
    await this.verificationTokens.markUsed(token.id);
    return this.users.markEmailVerified(token.userId);
  }

  async login(email: string, password: string, meta: RequestMetadata = {}): Promise<LoginResult> {
    let user: User;
    try {
      user = await this.users.getByEmail(email);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        await this.accessEvents.record(null, null, 'failed_auth', meta.ipAddress ?? null, meta.userAgent ?? null, { reason: 'unknown_email' });
        throw new InvalidCredentialsError();
      }
      throw err;
    }

    // Checked before verifying the password (not after failing it) so a
    // locked-out attacker's guesses never reach bcrypt — cheap to check,
    // and avoids doing real password-verification work on a request that's
    // going to be rejected regardless of what password was supplied.
    const recentFailures = await this.accessEvents.countRecentFailedPasswordAttempts(
      user.id, new Date(Date.now() - LOCKOUT_WINDOW_MS)
    );
    if (recentFailures >= LOCKOUT_FAILURE_THRESHOLD) {
      await this.accessEvents.record(null, user.id, 'failed_auth', meta.ipAddress ?? null, meta.userAgent ?? null, { reason: 'account_locked' });
      throw new AccountLockedError(LOCKOUT_WINDOW_MS);
    }

    const passwordHash = await this.users.getPasswordHash(user.id);
    const validPassword = passwordHash !== null && (await verifyPassword(password, passwordHash));
    if (!validPassword) {
      await this.accessEvents.record(null, user.id, 'failed_auth', meta.ipAddress ?? null, meta.userAgent ?? null, { reason: 'bad_password' });
      throw new InvalidCredentialsError();
    }

    if (user.status !== 'active') {
      await this.accessEvents.record(null, user.id, 'failed_auth', meta.ipAddress ?? null, meta.userAgent ?? null, { reason: 'account_not_active', status: user.status });
      throw new AccountNotActiveError(user.status);
    }

    const rawSessionToken = generateSessionToken();
    const session = await this.sessions.createSession(user.id, hashToken(rawSessionToken), defaultSessionExpiry(), meta.ipAddress, meta.userAgent);
    await this.users.recordLogin(user.id);
    await this.accessEvents.record(null, user.id, 'login', meta.ipAddress ?? null, meta.userAgent ?? null, { sessionId: session.id });

    return { user, session, rawSessionToken };
  }

  async logout(rawSessionToken: string, meta: RequestMetadata = {}): Promise<void> {
    const session = await this.sessions.getByTokenHash(hashToken(rawSessionToken)).catch(() => null);
    if (!session) return; // idempotent: logging out an unknown/already-gone session is a no-op, not an error
    if (!session.revokedAt) {
      await this.sessions.revoke(session.id);
    }
    await this.accessEvents.record(null, session.userId, 'logout', meta.ipAddress ?? null, meta.userAgent ?? null, { sessionId: session.id });
  }

  /** Fail-closed: any expired/revoked/unknown session throws rather than silently returning null. */
  async validateSession(rawSessionToken: string): Promise<ValidatedSession> {
    let session: Session;
    try {
      session = await this.sessions.getByTokenHash(hashToken(rawSessionToken));
    } catch (err) {
      if (err instanceof SessionNotFoundError) throw new SessionInvalidError();
      throw err;
    }
    if (session.revokedAt) throw new SessionRevokedError();
    if (session.expiresAt.getTime() < Date.now()) throw new SessionExpiredError();

    const user = await this.users.getById(session.userId);
    if (user.status !== 'active') throw new AccountNotActiveError(user.status);

    return { user, session };
  }

  async revokeSession(sessionId: string, meta: RequestMetadata = {}): Promise<void> {
    const session = await this.sessions.revoke(sessionId);
    await this.accessEvents.record(null, session.userId, 'session_revocation', meta.ipAddress ?? null, meta.userAgent ?? null, { sessionId: session.id });
  }

  async revokeAllUserSessions(userId: string, meta: RequestMetadata = {}): Promise<number> {
    const count = await this.sessions.revokeAllForUser(userId);
    await this.accessEvents.record(null, userId, 'session_revocation', meta.ipAddress ?? null, meta.userAgent ?? null, { count, scope: 'all_sessions' });
    return count;
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const passwordHash = await this.users.getPasswordHash(userId);
    const validPassword = passwordHash !== null && (await verifyPassword(oldPassword, passwordHash));
    if (!validPassword) throw new InvalidCredentialsError();

    const newHash = await hashPassword(newPassword);
    await this.users.updatePasswordHash(userId, newHash);
    // A password change is a security-sensitive event — revoke every existing session so the new
    // credential immediately supersedes anything issued under the old one (defense in depth).
    await this.sessions.revokeAllForUser(userId);
  }
}
