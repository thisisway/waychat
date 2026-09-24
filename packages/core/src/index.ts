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
  actorForSession,
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

export { loadVisibleConversation } from './modules/conversations/application/access.js';
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

export {
  createInbox,
  listInboxes,
  visibleInboxIds,
  updateInbox,
  rotateIdentitySecret,
  deleteInbox,
  listInboxMembers,
  setInboxMembers,
  CHANNEL_TYPES,
  type InboxView,
  type InboxMemberView,
  type ChannelType,
} from './modules/inbox/application/inboxes.js';
export {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  verifyApiKey,
  API_SCOPES,
  type ApiKeyView,
  type ApiKeyPrincipal,
  type ApiScope,
} from './modules/inbox/application/api-keys.js';
export {
  createContact,
  getContact,
  updateContact,
  deleteContact,
  listContacts,
  findOrCreateContactByIdentity,
  normalizePhone,
  type ContactView,
} from './modules/contacts/application/contacts.js';

export {
  receiveInboundMessage,
  sendMessage,
  listMessages,
  MAX_CONTENT_LENGTH,
  type MessageView,
  type InboundMessageInput,
  type InboundResult,
} from './modules/conversations/application/messages.js';
export {
  listConversations,
  getConversation,
  updateConversation,
  markConversationRead,
  conversationCounts,
  STATUSES,
  PRIORITIES,
  type ConversationSummary,
  type ConversationDetail,
  type ConversationStatus,
  type ListConversationsOptions,
} from './modules/conversations/application/conversations.js';
export {
  listLabels,
  createLabel,
  deleteLabel,
  addLabel,
  removeLabel,
  listCannedResponses,
  createCannedResponse,
  updateCannedResponse,
  deleteCannedResponse,
  type LabelView,
  type CannedResponseView,
} from './modules/conversations/application/labels.js';

export {
  canSeeEvent,
  loadEventScope,
  type EventScope,
} from './modules/events/application/visibility.js';
export {
  listEventsSince,
  currentCursor,
  type SyncResult,
} from './modules/events/application/sync.js';
export {
  loadVisitorDelivery,
  openSessionInput,
  openWidgetSession,
  verifyVisitorToken,
  visitorMessages,
  visitorSend,
  visitorSendInput,
  widgetOriginAllowed,
  type Visitor,
  type VisitorMessage,
  type WidgetSession,
} from './modules/widget/application/widget.js';
export {
  claimAttachments,
  completeUpload,
  downloadUrlFor,
  getOwnAttachment,
  MAX_ATTACHMENTS_PER_MESSAGE,
  requestUpload,
  requestUploadInput,
  scanAttachment,
  toAttachmentView,
  type AttachmentView,
  type UploadSubject,
} from './modules/attachments/application/attachments.js';
export type { FileServices } from './context.js';
export {
  agentAttachmentUrl,
  visitorAttachmentUrl,
} from './modules/attachments/application/download.js';
export { fileServicesFromEnv } from './files.js';
