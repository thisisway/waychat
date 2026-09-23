import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, tsz, updatedAt } from './common.js';
import { accounts, users } from './identity.js';

const accountRef = () =>
  uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' });

/**
 * Contadores por conta. `event_seq` dá o cursor de eventos SEM LACUNAS (ADR 0006): o trigger do outbox faz
 * UPSERT nesta linha, que fica travada até o COMMIT, então a ordem de commit é a ordem do cursor.
 * `conversation_seq` numera as conversas (`display_id`) de cada conta.
 */
export const accountCounters = pgTable('account_counters', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  eventSeq: bigint('event_seq', { mode: 'number' }).notNull().default(0),
  conversationSeq: bigint('conversation_seq', { mode: 'number' }).notNull().default(0),
});

export const inboxes = pgTable(
  'inboxes',
  {
    id: id(),
    accountId: accountRef(),
    name: text('name').notNull(),
    channelType: text('channel_type').notNull(),
    /** Identificador público da inbox (widget/API). Não é segredo; localiza a inbox antes de haver tenant. */
    publicKey: text('public_key').notNull().unique(),
    /** Configuração do canal (segredos incluídos) cifrada com AES-256-GCM, AAD `inbox:<id>`. */
    configEncrypted: text('config_encrypted'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('inboxes_account_name_uq').on(t.accountId, t.name),
    check('inboxes_channel_type_ck', sql`${t.channelType} in ('api', 'widget')`),
  ],
);

export const inboxMembers = pgTable(
  'inbox_members',
  {
    accountId: accountRef(),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.inboxId, t.userId] }),
    index('inbox_members_user_idx').on(t.userId),
  ],
);

export const contacts = pgTable(
  'contacts',
  {
    id: id(),
    accountId: accountRef(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    attributes: jsonb('attributes')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('contacts_account_created_idx').on(t.accountId, t.createdAt)],
);

/** Como o contato aparece em cada canal (wa_id, e-mail, id do visitante do widget...). Único por conta+canal. */
export const contactIdentities = pgTable(
  'contact_identities',
  {
    id: id(),
    accountId: accountRef(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('contact_identities_uq').on(t.accountId, t.channel, t.externalId),
    index('contact_identities_contact_idx').on(t.contactId),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    accountId: accountRef(),
    /** Número sequencial por conta, sobrescrito por trigger a partir de `account_counters` (o default 0 só satisfaz o tipo). */
    displayId: bigint('display_id', { mode: 'number' }).notNull().default(0),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('none'),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    lastCustomerMessageAt: tsz('last_customer_message_at'),
    lastActivityAt: tsz('last_activity_at').notNull().defaultNow(),
    snoozedUntil: tsz('snoozed_until'),
    resolvedAt: tsz('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('conversations_display_uq').on(t.accountId, t.displayId),
    index('conversations_inbox_idx').on(
      t.accountId,
      t.status,
      t.assigneeId,
      t.lastActivityAt.desc(),
    ),
    index('conversations_inbox_activity_idx').on(t.inboxId, t.lastActivityAt.desc()),
    index('conversations_contact_idx').on(t.contactId),
    check(
      'conversations_status_ck',
      sql`${t.status} in ('open', 'pending', 'snoozed', 'resolved')`,
    ),
    check(
      'conversations_priority_ck',
      sql`${t.priority} in ('none', 'low', 'medium', 'high', 'urgent')`,
    ),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    accountId: accountRef(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Cópia de `conversations.inbox_id`: o filtro de visibilidade e o `source_id` único não precisam de JOIN. */
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(),
    senderType: text('sender_type').notNull(),
    senderId: uuid('sender_id'),
    type: text('type').notNull().default('text'),
    content: text('content'),
    contentAttributes: jsonb('content_attributes')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Nota interna: nunca sai para o cliente. */
    private: boolean('private').notNull().default(false),
    replyToId: uuid('reply_to_id'),
    /** Id da mensagem no canal de origem (wamid, id do e-mail...). Único por inbox: entrega duplicada não duplica. */
    sourceId: text('source_id'),
    /** UUID gerado pelo cliente (UI otimista): reenvio com o mesmo valor devolve a mensagem já criada. */
    clientMessageId: uuid('client_message_id'),
    status: text('status').notNull().default('sent'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt.desc(), t.id),
    uniqueIndex('messages_inbox_source_uq')
      .on(t.inboxId, t.sourceId)
      .where(sql`${t.sourceId} is not null`),
    uniqueIndex('messages_client_id_uq')
      .on(t.accountId, t.clientMessageId)
      .where(sql`${t.clientMessageId} is not null`),
    check('messages_direction_ck', sql`${t.direction} in ('in', 'out')`),
    check('messages_sender_ck', sql`${t.senderType} in ('contact', 'user', 'bot', 'system')`),
    check(
      'messages_status_ck',
      sql`${t.status} in ('queued', 'sent', 'delivered', 'read', 'failed')`,
    ),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    accountId: accountRef(),
    /** Nulo enquanto o upload ainda não foi associado a uma mensagem. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull().unique(),
    fileName: text('file_name').notNull(),
    /** Tipo detectado pelos magic bytes, nunca o declarado pelo cliente. */
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    scanStatus: text('scan_status').notNull().default('pending'),
    createdAt: createdAt(),
  },
  (t) => [
    index('attachments_message_idx').on(t.messageId),
    check('attachments_scan_ck', sql`${t.scanStatus} in ('pending', 'clean', 'infected', 'error')`),
  ],
);

export const labels = pgTable(
  'labels',
  {
    id: id(),
    accountId: accountRef(),
    name: text('name').notNull(),
    color: text('color').notNull().default('#6a6e75'),
    createdAt: createdAt(),
  },
  (t) => [unique('labels_account_name_uq').on(t.accountId, t.name)],
);

export const conversationLabels = pgTable(
  'conversation_labels',
  {
    accountId: accountRef(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.labelId] })],
);

export const cannedResponses = pgTable(
  'canned_responses',
  {
    id: id(),
    accountId: accountRef(),
    /** Atalho digitado após `/` no compositor. */
    shortcut: text('shortcut').notNull(),
    content: text('content').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('canned_responses_shortcut_uq').on(t.accountId, t.shortcut)],
);
