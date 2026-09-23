import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './common.js';

/** Tenant. A própria linha é o tenant: a RLS compara `id` com o tenant da transação. */
export const accounts = pgTable('accounts', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  require2fa: boolean('require_2fa').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Identidade global (uma pessoa pode pertencer a vários tenants via account_users). Sem RLS por tenant: o login precisa achá-la antes de saber o tenant. */
export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    locale: text('locale').notNull().default('pt-BR'),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: tsz('locked_until'),
    lastLoginAt: tsz('last_login_at'),
    disabledAt: tsz('disabled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`)],
);

export const roles = pgTable(
  'roles',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique('roles_account_name_uq').on(t.accountId, t.name)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const accountUsers = pgTable(
  'account_users',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.userId] }),
    index('account_users_user_idx').on(t.userId),
  ],
);

/** Sessão com refresh token rotativo. `familyId` agrupa a cadeia de rotações: reuso de token antigo revoga a família inteira. */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Conta ativa da sessão (o access token carrega o mesmo valor). */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    refreshHash: text('refresh_hash').notNull().unique(),
    expiresAt: tsz('expires_at').notNull(),
    revokedAt: tsz('revoked_at'),
    revokedReason: text('revoked_reason'),
    replacedBy: uuid('replaced_by'),
    mfaVerifiedAt: tsz('mfa_verified_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastUsedAt: tsz('last_used_at'),
  },
  (t) => [index('sessions_family_idx').on(t.familyId), index('sessions_user_idx').on(t.userId)],
);

export const userMfaFactors = pgTable(
  'user_mfa_factors',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('totp'),
    /** Segredo TOTP cifrado (AES-256-GCM); nunca em claro. */
    secretEncrypted: text('secret_encrypted').notNull(),
    confirmedAt: tsz('confirmed_at'),
    /** Último passo de tempo aceito: impede reuso do mesmo código dentro da janela. */
    lastUsedStep: integer('last_used_step'),
    createdAt: createdAt(),
  },
  (t) => [unique('user_mfa_factors_user_type_uq').on(t.userId, t.type)],
);

export const userRecoveryCodes = pgTable(
  'user_recovery_codes',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: tsz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('user_recovery_codes_user_idx').on(t.userId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Prefixo público da chave (para localizar); o segredo só existe em hash. */
    keyPrefix: text('key_prefix').notNull().unique(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    expiresAt: tsz('expires_at'),
    lastUsedAt: tsz('last_used_at'),
    revokedAt: tsz('revoked_at'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('api_keys_account_idx').on(t.accountId)],
);
