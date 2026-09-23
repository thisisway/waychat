export { createCtx, coreConfigFromEnv, type Ctx, type CoreConfig } from './context.js';
export { DomainError, type DomainErrorCode } from './errors.js';
export { Keyring } from './crypto/envelope.js';
export { randomToken } from './crypto/tokens.js';

export { recordAudit, type AuditEntry } from './modules/audit/application/record.js';
export { enqueueEvent } from './modules/events/application/enqueue.js';

export {
  registerAccount,
  slugify,
  type RegisterAccountInput,
} from './modules/identity/application/register-account.js';
export {
  login,
  completeMfaLogin,
  completeEnrollmentLogin,
  lockSeconds,
  LOCK_AFTER_FAILURES,
  type LoginInput,
  type LoginResult,
} from './modules/identity/application/login.js';
export {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  hasConfirmedTotp,
  countUnusedRecoveryCodes,
  type SecondFactor,
} from './modules/identity/application/mfa.js';
export {
  authenticate,
  refreshSession,
  logout,
  listSessions,
  revokeOwnSessions,
  type AuthenticatedActor,
  type TokenPair,
  type ClientMeta,
  type SessionSummary,
} from './modules/identity/application/sessions.js';
export { verifyChallenge } from './modules/identity/infra/jwt.js';

export { assertCan, assertCanGrant, type Actor } from './modules/authz/application/actor.js';
export {
  listRoles,
  createRole,
  updateRole,
  deleteRole,
  type RoleView,
} from './modules/authz/application/roles.js';
export {
  listMembers,
  addMember,
  changeMemberRole,
  removeMember,
  type MemberView,
} from './modules/authz/application/members.js';
export { listAuditLogs, type AuditLogView } from './modules/audit/application/list.js';
export {
  getMe,
  getAccount,
  updateAccount,
  type MeView,
} from './modules/account/application/account.js';
