// @infinicus/authentication — password credentials, session lifecycle, service-account API keys.
export {
  InvalidCredentialsError, AccountNotActiveError, AccountLockedError,
  SessionExpiredError, SessionRevokedError, SessionInvalidError,
  ApiKeyInvalidError, WeakPasswordError, VerificationTokenInvalidError,
} from './errors.js';

export type { EmailMessage, EmailSender } from './email/EmailSender.js';
export { ResendEmailSender, EmailSendError } from './email/ResendEmailSender.js';
export { NoopEmailSender } from './email/NoopEmailSender.js';
export { createEmailSender, resolveEmailConfig } from './email/createEmailSender.js';
export type { EmailConfig } from './email/createEmailSender.js';

export { validatePasswordStrength, hashPassword, verifyPassword } from './password.js';

export {
  hashToken, generateSessionToken, defaultSessionExpiry,
  generateApiKey, parseApiKey,
} from './tokens.js';
export type { GeneratedApiKey } from './tokens.js';

export { AuthenticationService } from './AuthenticationService.js';
export type { LoginResult, ValidatedSession, RequestMetadata } from './AuthenticationService.js';
