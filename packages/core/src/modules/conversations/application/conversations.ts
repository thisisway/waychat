import { schema, withTenant } from '@waychat/db';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../../context.js';
import { DomainError } from '../../../errors.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';
import { enqueueEvent } from '../../events/application/enqueue.js';
import {
  assertCanRead,
  loadVisibleConversation,
  memberInboxIds,
  nowMs,
  seesAllInboxes,
} from './access.js';
import { decodeCursor } from './messages.js';

const {
  conversations,
  contacts,
  inboxes,
  inboxMembers,
  conversationLabels,
  labels,
  conversationReads,
} = schema;

export const STATUSES = ['open', 'pending', 'snoozed', 'resolved'] as const;
export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type ConversationStatus = (typeof STATUSES)[number];

export interface ConversationSummary {
  id: string;
  displayId: number;
  inboxId: string;
  status: ConversationStatus;
  priority: (typeof PRIORITIES)[number];
  assigneeId: string | null;
  contact: { id: string; name: string; phone: string | null; email: string | null };
  /** Prévia da última mensagem visível ao cliente (notas internas não entram). */
  lastMessage: string | null;
  lastActivityAt: Date;
  unreadCount: number;
}

export interface ConversationDetail extends ConversationSummary {
  snoozedUntil: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
  inbox: { id: string; name: string; channelType: string };
  labels: { id: string; name: string; color: string }[];
}

const encodeActivityCursor = (at: Date, id: string) =>
  Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');

export interface ListConversationsOptions {
  status?: ConversationStatus;
  /** `me`, `unassigned` ou o id de um atendente. */
  assignee?: string;
  inboxId?: string;
  labelId?: string;
  unreadOnly?: boolean;
  search?: string;
  limit?: number;
  before?: string;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Escopo de visibilidade da consulta: `null` = sem restrição; lista vazia = nada visível. */
async function visibilityScope(tx: Parameters<Parameters<typeof withTenant>[2]>[0], actor: Actor) {
  return seesAllInboxes(actor) ? null : memberInboxIds(tx, actor);
}

const summarySelect = (actor: Actor) => ({
  id: conversations.id,
  displayId: conversations.displayId,
  inboxId: conversations.inboxId,
  status: conversations.status,
  priority: conversations.priority,
  assigneeId: conversations.assigneeId,
  lastActivityAt: conversations.lastActivityAt,
  snoozedUntil: conversations.snoozedUntil,
  resolvedAt: conversations.resolvedAt,
  createdAt: conversations.createdAt,
  contactId: contacts.id,
  contactName: contacts.name,
  contactPhone: contacts.phone,
  contactEmail: contacts.email,
  lastMessage: sql<string | null>`(
    select left(m.content, 140) from messages m
    where m.conversation_id = ${conversations.id} and m.private = false
    order by m.created_at desc, m.id desc limit 1)`,
  unreadCount: sql<number>`(
    select count(*)::int from messages m
    where m.conversation_id = ${conversations.id} and m.direction = 'in' and m.private = false
      and m.created_at > coalesce(
        (select r.last_read_at from conversation_reads r
          where r.conversation_id = ${conversations.id} and r.user_id = ${actor.userId}),
        '-infinity'::timestamptz))`,
});

type SummaryRow = {
  id: string;
  displayId: number;
  inboxId: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  lastActivityAt: Date;
  contactId: string;
  contactName: string;
  contactPhone: string | null;
  contactEmail: string | null;
  lastMessage: string | null;
  unreadCount: number;
};

const toSummary = (r: SummaryRow): ConversationSummary => ({
  id: r.id,
  displayId: r.displayId,
  inboxId: r.inboxId,
  status: r.status as ConversationStatus,
  priority: r.priority as ConversationSummary['priority'],
  assigneeId: r.assigneeId,
  contact: { id: r.contactId, name: r.contactName, phone: r.contactPhone, email: r.contactEmail },
  lastMessage: r.lastMessage,
  lastActivityAt: r.lastActivityAt,
  unreadCount: r.unreadCount,
});

/**
 * Lista de conversas: mais recentes primeiro, cursor composto (atividade, id) sem OFFSET.
 * Só devolve conversas de inboxes que o usuário pode ver.
 */
export async function listConversations(
  ctx: Ctx,
  actor: Actor,
  opts: ListConversationsOptions = {},
): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
  assertCanRead(actor);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const before = opts.before ? decodeCursor(opts.before) : null;

  const rows = await withTenant(ctx.db, actor.accountId, async (tx) => {
    const scope = await visibilityScope(tx, actor);
    if (scope && scope.length === 0) return [];
    const phoneDigits = opts.search?.replace(/[^\d]/g, '') ?? '';
    const where: (SQL | undefined)[] = [
      scope ? inArray(conversations.inboxId, scope) : undefined,
      opts.status ? eq(conversations.status, opts.status) : undefined,
      opts.inboxId ? eq(conversations.inboxId, opts.inboxId) : undefined,
      opts.assignee === 'me'
        ? eq(conversations.assigneeId, actor.userId)
        : opts.assignee === 'unassigned'
          ? isNull(conversations.assigneeId)
          : opts.assignee
            ? eq(conversations.assigneeId, opts.assignee)
            : undefined,
      opts.labelId
        ? sql`exists (select 1 from conversation_labels cl where cl.conversation_id = ${conversations.id} and cl.label_id = ${opts.labelId})`
        : undefined,
      opts.unreadOnly
        ? sql`exists (select 1 from messages m where m.conversation_id = ${conversations.id} and m.direction = 'in' and m.private = false
            and m.created_at > coalesce((select r.last_read_at from conversation_reads r where r.conversation_id = ${conversations.id} and r.user_id = ${actor.userId}), '-infinity'::timestamptz))`
        : undefined,
      opts.search?.trim()
        ? or(
            ilike(contacts.name, `%${escapeLike(opts.search.trim())}%`),
            ilike(contacts.email, `%${escapeLike(opts.search.trim())}%`),
            phoneDigits.length >= 3 ? ilike(contacts.phone, `%${phoneDigits}%`) : undefined,
            /^\d+$/.test(opts.search.trim())
              ? eq(conversations.displayId, Number(opts.search.trim()))
              : undefined,
          )
        : undefined,
      before
        ? sql`(${conversations.lastActivityAt}, ${conversations.id}) < (${before.at.toISOString()}::timestamptz, ${before.id}::uuid)`
        : undefined,
    ];
    return tx
      .select(summarySelect(actor))
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .where(and(...where))
      .orderBy(desc(conversations.lastActivityAt), desc(conversations.id))
      .limit(limit + 1);
  });

  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(toSummary),
    nextCursor:
      rows.length > limit && last ? encodeActivityCursor(last.lastActivityAt, last.id) : null,
  };
}

/** Contadores da barra lateral (conversas abertas), respeitando a visibilidade. */
export async function conversationCounts(
  ctx: Ctx,
  actor: Actor,
): Promise<{ all: number; unassigned: number; mine: number; unread: number }> {
  assertCanRead(actor);
  // Numa consulta de UMA tabela o Drizzle omite o prefixo da coluna; dentro da subconsulta `id` viraria o de `messages`.
  const convId = sql.raw('"conversations"."id"');
  return withTenant(ctx.db, actor.accountId, async (tx) => {
    const scope = await visibilityScope(tx, actor);
    if (scope && scope.length === 0) return { all: 0, unassigned: 0, mine: 0, unread: 0 };
    const [row] = await tx
      .select({
        all: sql<number>`count(*)::int`,
        unassigned: sql<number>`count(*) filter (where ${conversations.assigneeId} is null)::int`,
        mine: sql<number>`count(*) filter (where ${conversations.assigneeId} = ${actor.userId})::int`,
        unread: sql<number>`count(*) filter (where exists (
          select 1 from messages m where m.conversation_id = ${convId} and m.direction = 'in' and m.private = false
            and m.created_at > coalesce((select r.last_read_at from conversation_reads r
              where r.conversation_id = ${convId} and r.user_id = ${actor.userId}), '-infinity'::timestamptz)))::int`,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.status, 'open'),
          scope ? inArray(conversations.inboxId, scope) : undefined,
        ),
      );
    return row ?? { all: 0, unassigned: 0, mine: 0, unread: 0 };
  });
}

export async function getConversation(
  ctx: Ctx,
  actor: Actor,
  conversationId: string,
): Promise<ConversationDetail> {
  return withTenant(ctx.db, actor.accountId, async (tx) => {
    await loadVisibleConversation(tx, actor, conversationId);
    const [row] = await tx
      .select({
        ...summarySelect(actor),
        inboxName: inboxes.name,
        inboxChannel: inboxes.channelType,
      })
      .from(conversations)
      .innerJoin(contacts, eq(contacts.id, conversations.contactId))
      .innerJoin(inboxes, eq(inboxes.id, conversations.inboxId))
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!row) throw new DomainError('not_found');
    const ls = await tx
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(conversationLabels)
      .innerJoin(labels, eq(labels.id, conversationLabels.labelId))
      .where(eq(conversationLabels.conversationId, conversationId))
      .orderBy(labels.name);
    return {
      ...toSummary(row),
      snoozedUntil: row.snoozedUntil,
      resolvedAt: row.resolvedAt,
      createdAt: row.createdAt,
      inbox: { id: row.inboxId, name: row.inboxName, channelType: row.inboxChannel },
      labels: ls,
    };
  });
}

export const updateConversationInput = z.object({
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.uuid().nullable().optional(),
  snoozedUntil: z.coerce.date().optional(),
});

/**
 * Altera status, prioridade, responsável ou adiamento. Regras:
 * - `snoozed` exige `snoozedUntil` no futuro; qualquer outro status limpa o adiamento;
 * - `resolved` registra `resolvedAt`, reabrir limpa;
 * - o responsável precisa ser membro da inbox da conversa.
 */
export async function updateConversation(
  ctx: Ctx,
  actor: Actor,
  conversationId: string,
  rawInput: unknown,
): Promise<ConversationDetail> {
  assertCan(actor, 'conversations:manage');
  const parsed = updateConversationInput.safeParse(rawInput);
  if (!parsed.success)
    throw new DomainError(
      'invalid_input',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  const input = parsed.data;

  await withTenant(ctx.db, actor.accountId, async (tx) => {
    const conv = await loadVisibleConversation(tx, actor, conversationId);
    const set: Record<string, unknown> = {};
    const fields: string[] = [];

    if (input.status !== undefined && input.status !== conv.status) {
      set['status'] = input.status;
      set['resolvedAt'] = input.status === 'resolved' ? nowMs : null;
      if (input.status === 'snoozed') {
        if (!input.snoozedUntil || input.snoozedUntil <= ctx.now()) {
          throw new DomainError('invalid_input', 'snoozedUntil deve estar no futuro');
        }
        set['snoozedUntil'] = input.snoozedUntil;
      } else {
        set['snoozedUntil'] = null;
      }
      fields.push('status');
    } else if (input.snoozedUntil !== undefined && conv.status === 'snoozed') {
      if (input.snoozedUntil <= ctx.now())
        throw new DomainError('invalid_input', 'snoozedUntil deve estar no futuro');
      set['snoozedUntil'] = input.snoozedUntil;
      fields.push('snoozedUntil');
    }
    if (input.priority !== undefined && input.priority !== conv.priority) {
      set['priority'] = input.priority;
      fields.push('priority');
    }
    if (input.assigneeId !== undefined && input.assigneeId !== conv.assigneeId) {
      if (input.assigneeId !== null) {
        const [m] = await tx
          .select({ u: inboxMembers.userId })
          .from(inboxMembers)
          .where(
            and(eq(inboxMembers.inboxId, conv.inboxId), eq(inboxMembers.userId, input.assigneeId)),
          )
          .limit(1);
        if (!m) throw new DomainError('invalid_input', 'o responsável precisa ser membro da inbox');
      }
      set['assigneeId'] = input.assigneeId;
      fields.push('assigneeId');
    }
    if (fields.length === 0) return;

    set['lastActivityAt'] = nowMs;
    await tx.update(conversations).set(set).where(eq(conversations.id, conv.id));
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'conversation',
      aggregateId: conv.id,
      type: 'conversation.updated',
      payload: { conversation_id: conv.id, inbox_id: conv.inboxId, fields },
    });
  });
  return getConversation(ctx, actor, conversationId);
}

/** Marca a conversa como lida pelo atendente (zera o contador de não lidas dele). */
export async function markConversationRead(
  ctx: Ctx,
  actor: Actor,
  conversationId: string,
): Promise<void> {
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    await loadVisibleConversation(tx, actor, conversationId);
    await tx
      .insert(conversationReads)
      .values({
        accountId: actor.accountId,
        conversationId,
        userId: actor.userId,
        lastReadAt: nowMs,
      })
      .onConflictDoUpdate({
        target: [conversationReads.conversationId, conversationReads.userId],
        set: { lastReadAt: nowMs },
      });
  });
}
