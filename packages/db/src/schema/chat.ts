import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
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
    /** Qualidade do número no canal (WhatsApp: GREEN/YELLOW/RED) e faixa de envio (TIER_1K...). */
    qualityRating: text('quality_rating'),
    messagingTier: text('messaging_tier'),
    qualityCheckedAt: tsz('quality_checked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('inboxes_account_name_uq').on(t.accountId, t.name),
    check('inboxes_channel_type_ck', sql`${t.channelType} in ('api', 'widget', 'whatsapp')`),
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
    /** Mensagem legível (em português) do motivo da falha; o código do provedor fica em `errorCode`. */
    error: text('error'),
    errorCode: text('error_code'),
    /** Tentativas de envio ao canal (idempotência do envio: ver ADR 0010). */
    attempts: integer('attempts').notNull().default(0),
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
      sql`${t.status} in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed')`,
    ),
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

/** Última leitura de cada atendente por conversa: base do contador de não lidas. */
export const conversationReads = pgTable(
  'conversation_reads',
  {
    accountId: accountRef(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastReadAt: tsz('last_read_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

/**
 * Arquivo enviado por atendente ou visitante. O objeto fica no S3 (`storage_key` é gerada no servidor);
 * só sai para o outro lado depois de `clean` (assinatura conferida + antivírus).
 * `awaiting_upload` → `scanning` → `clean` | `infected` | `rejected`.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    accountId: accountRef(),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    /** Quem enviou: `user` (uploaderId = users.id) ou `visitor` (uploaderId = identidade do contato no widget). */
    uploaderType: text('uploader_type').notNull(),
    uploaderId: text('uploader_id').notNull(),
    /** Preenchido quando o anexo é enviado junto de uma mensagem. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    /** Tipo DETECTADO pelo conteúdo (nunca o declarado pelo cliente). Nulo até a conclusão do upload. */
    contentType: text('content_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    storageKey: text('storage_key').notNull().unique(),
    status: text('status').notNull().default('awaiting_upload'),
    rejectReason: text('reject_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('attachments_message_idx').on(t.messageId),
    index('attachments_status_idx').on(t.status, t.createdAt),
    check('attachments_uploader_ck', sql`${t.uploaderType} in ('user', 'visitor', 'contact')`),
    check(
      'attachments_status_ck',
      sql`${t.status} in ('awaiting_upload', 'scanning', 'clean', 'infected', 'rejected')`,
    ),
    check('attachments_size_ck', sql`${t.sizeBytes} > 0`),
  ],
);

/**
 * Templates de mensagem do canal (WhatsApp). Sincronizados com a Meta; só `approved` pode ser enviado.
 * `components` guarda a definição original (cabeçalho, corpo com variáveis, rodapé, botões) para a pré-visualização.
 */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: id(),
    accountId: accountRef(),
    inboxId: uuid('inbox_id')
      .notNull()
      .references(() => inboxes.id, { onDelete: 'cascade' }),
    providerTemplateId: text('provider_template_id'),
    name: text('name').notNull(),
    language: text('language').notNull(),
    category: text('category').notNull().default('UTILITY'),
    status: text('status').notNull().default('pending'),
    /** Motivo informado pela Meta quando rejeita ou pausa. */
    reason: text('reason'),
    components: jsonb('components')
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('message_templates_inbox_name_lang_uq').on(t.inboxId, t.name, t.language),
    check(
      'message_templates_status_ck',
      sql`${t.status} in ('pending', 'approved', 'rejected', 'paused', 'disabled', 'other')`,
    ),
  ],
);

/** Contato que pediu para não receber mais mensagens (SAIR/PARAR). Campanhas consultam esta tabela antes de enviar. */
export const contactOptOuts = pgTable(
  'contact_opt_outs',
  {
    id: id(),
    accountId: accountRef(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    /** Palavra que disparou o opt-out (auditoria). */
    keyword: text('keyword').notNull(),
    optedOutAt: tsz('opted_out_at').notNull().defaultNow(),
    /** Preenchido quando o contato volta a aceitar (opt-in explícito). */
    optedInAt: tsz('opted_in_at'),
  },
  (t) => [unique('contact_opt_outs_uq').on(t.accountId, t.contactId, t.channel)],
);
