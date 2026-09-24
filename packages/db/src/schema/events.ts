import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './identity.js';
import { createdAt, id, tsz } from './common.js';

/** Append-only (trigger + REVOKE + sem policy de UPDATE/DELETE). Sem FK para sobreviver à exclusão de conta/usuário. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    accountId: uuid('account_id'),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_account_created_idx').on(t.accountId, t.createdAt)],
);

/** Evento bruto de entrada. Único por (inbox, id externo): a segunda entrega do mesmo webhook é descartada. */
export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    inboxId: uuid('inbox_id').notNull(),
    externalId: text('external_id').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('received'),
    /** Motivo da falha de processamento (sem dados pessoais). */
    error: text('error'),
    receivedAt: createdAt(),
    processedAt: tsz('processed_at'),
  },
  (t) => [unique('inbound_events_inbox_external_uq').on(t.inboxId, t.externalId)],
);

/** Transactional Outbox: gravado na mesma transação da mudança de estado; o relay publica e marca `published_at`. */
export const outbox = pgTable(
  'outbox',
  {
    id: id(),
    /** Ordem global de inserção: só usada pelo relay para varrer pendentes. */
    cursor: bigint('cursor', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    /** Cursor público, por conta e SEM LACUNAS (trigger + `account_counters`, ADR 0006). Base do `GET /sync`. O default 0 é sempre sobrescrito pelo trigger. */
    accountSeq: bigint('account_seq', { mode: 'number' }).notNull().default(0),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    /** Contexto W3C (`traceparent`) da requisição que gerou o evento: o trace continua no worker. */
    traceContext: text('trace_context'),
    createdAt: createdAt(),
    publishedAt: tsz('published_at'),
  },
  (t) => [
    index('outbox_pending_idx')
      .on(t.cursor)
      .where(sql`${t.publishedAt} is null`),
    index('outbox_account_cursor_idx').on(t.accountId, t.cursor),
    unique('outbox_account_seq_uq').on(t.accountId, t.accountSeq),
  ],
);
