import { schema, withTenant, type Tx } from '@waychat/db';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../../context.js';
import { uniqueViolation } from '../../../db-errors.js';
import { DomainError } from '../../../errors.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';
import { findOrCreateContactByIdentity } from '../../contacts/application/contacts.js';
import { enqueueEvent } from '../../events/application/enqueue.js';
import { loadVisibleConversation, nowMs } from './access.js';

const { conversations, messages, inboxes } = schema;

export const MAX_CONTENT_LENGTH = 10_000;

export interface MessageView {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  senderType: 'contact' | 'user' | 'bot' | 'system';
  senderId: string | null;
  type: string;
  content: string | null;
  contentAttributes: Record<string, unknown>;
  private: boolean;
  replyToId: string | null;
  status: string;
  clientMessageId: string | null;
  createdAt: Date;
}

export const toMessageView = (r: typeof messages.$inferSelect): MessageView => ({
  id: r.id,
  conversationId: r.conversationId,
  direction: r.direction as MessageView['direction'],
  senderType: r.senderType as MessageView['senderType'],
  senderId: r.senderId,
  type: r.type,
  content: r.content,
  contentAttributes: r.contentAttributes as Record<string, unknown>,
  private: r.private,
  replyToId: r.replyToId,
  status: r.status,
  clientMessageId: r.clientMessageId,
  createdAt: r.createdAt,
});

const contentSchema = z.string().trim().min(1).max(MAX_CONTENT_LENGTH);

/** Lock de transação por chave de texto: serializa quem disputa o mesmo recurso (uma conversa, uma identidade). */
async function lock(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

// ---------- entrada (widget / canal API) ----------

export interface InboundMessageInput {
  accountId: string;
  inboxId: string;
  identity: {
    channel: string;
    externalId: string;
    name: string;
    email?: string | null;
    phone?: string | null;
  };
  content: string;
  /** Id da mensagem no canal de origem. Se já existir nesta inbox, a entrega é descartada (idempotência). */
  sourceId?: string;
  /** UUID gerado pelo cliente: reenvio com o mesmo valor não duplica. */
  clientMessageId?: string;
  contentAttributes?: Record<string, unknown>;
  /** Restringe a inbox ao canal esperado (o canal API não pode escrever numa inbox de widget, e vice-versa). */
  channelType?: 'api' | 'widget';
}

export interface InboundResult {
  message: MessageView;
  conversationId: string;
  contactId: string;
  conversationCreated: boolean;
  /** `true` quando a mensagem já existia (reenvio/entrega duplicada) e nada novo foi gravado. */
  duplicate: boolean;
}

/**
 * Pipeline de entrada de uma mensagem do cliente final. Tudo numa transação, sob lock da identidade:
 * duas mensagens simultâneas do mesmo visitante nunca criam duas conversas.
 * Contato → conversa (reaproveita a mais recente da inbox; se estava resolvida/adiada, reabre) → mensagem → eventos.
 */
export async function receiveInboundMessage(
  ctx: Ctx,
  input: InboundMessageInput,
): Promise<InboundResult> {
  const parsed = contentSchema.safeParse(input.content);
  if (!parsed.success) throw new DomainError('invalid_input', 'conteúdo vazio ou grande demais');
  const content = parsed.data;

  return withTenant(ctx.db, input.accountId, async (tx) => {
    const [inbox] = await tx.select().from(inboxes).where(eq(inboxes.id, input.inboxId)).limit(1);
    if (!inbox || (input.channelType && inbox.channelType !== input.channelType))
      throw new DomainError('not_found');
    if (!inbox.enabled) throw new DomainError('inbox_disabled');

    await lock(tx, `in:${input.inboxId}:${input.identity.channel}:${input.identity.externalId}`);

    const existing = await findExisting(
      tx,
      input.accountId,
      input.inboxId,
      input.sourceId,
      input.clientMessageId,
    );
    if (existing) {
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, existing.conversationId))
        .limit(1);
      return {
        message: toMessageView(existing),
        conversationId: existing.conversationId,
        contactId: conv?.contactId ?? '',
        conversationCreated: false,
        duplicate: true,
      };
    }

    const { contactId } = await findOrCreateContactByIdentity(tx, input.accountId, input.identity);

    const [latest] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.inboxId, input.inboxId), eq(conversations.contactId, contactId)))
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(1);

    let conversationId: string;
    let created = false;
    if (!latest) {
      const [c] = await tx
        .insert(conversations)
        .values({
          accountId: input.accountId,
          inboxId: input.inboxId,
          contactId,
          lastActivityAt: nowMs,
        })
        .returning({ id: conversations.id });
      if (!c) throw new Error('falha ao criar conversa');
      conversationId = c.id;
      created = true;
    } else {
      conversationId = latest.id;
    }

    const [row] = await tx
      .insert(messages)
      .values({
        accountId: input.accountId,
        conversationId,
        inboxId: input.inboxId,
        direction: 'in',
        senderType: 'contact',
        senderId: contactId,
        content,
        contentAttributes: input.contentAttributes ?? {},
        sourceId: input.sourceId ?? null,
        clientMessageId: input.clientMessageId ?? null,
        createdAt: nowMs,
      })
      .returning();
    if (!row) throw new Error('falha ao gravar mensagem');

    const reopened = !!latest && (latest.status === 'resolved' || latest.status === 'snoozed');
    await tx
      .update(conversations)
      .set({
        lastCustomerMessageAt: nowMs,
        lastActivityAt: nowMs,
        ...(reopened ? { status: 'open', resolvedAt: null, snoozedUntil: null } : {}),
      })
      .where(eq(conversations.id, conversationId));

    if (created) {
      await enqueueEvent(tx, {
        accountId: input.accountId,
        aggregateType: 'conversation',
        aggregateId: conversationId,
        type: 'conversation.created',
        payload: { conversation_id: conversationId, inbox_id: input.inboxId },
      });
    } else if (reopened) {
      await enqueueEvent(tx, {
        accountId: input.accountId,
        aggregateType: 'conversation',
        aggregateId: conversationId,
        type: 'conversation.updated',
        payload: { conversation_id: conversationId, inbox_id: input.inboxId, fields: ['status'] },
      });
    }
    await enqueueEvent(tx, {
      accountId: input.accountId,
      aggregateType: 'message',
      aggregateId: row.id,
      type: 'message.created',
      payload: {
        message_id: row.id,
        conversation_id: conversationId,
        inbox_id: input.inboxId,
        private: false,
        direction: 'in',
      },
    });
    return {
      message: toMessageView(row),
      conversationId,
      contactId,
      conversationCreated: created,
      duplicate: false,
    };
  });
}

async function findExisting(
  tx: Tx,
  accountId: string,
  inboxId: string,
  sourceId?: string,
  clientMessageId?: string,
) {
  if (sourceId) {
    const [r] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.inboxId, inboxId), eq(messages.sourceId, sourceId)))
      .limit(1);
    if (r) return r;
  }
  if (clientMessageId) {
    const [r] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.accountId, accountId), eq(messages.clientMessageId, clientMessageId)))
      .limit(1);
    if (r) return r;
  }
  return undefined;
}

// ---------- saída (atendente) ----------

export const sendMessageInput = z.object({
  conversationId: z.uuid(),
  content: contentSchema,
  /** Nota interna: só a equipe vê; nunca vai ao cliente. */
  private: z.boolean().default(false),
  /** UUID gerado pelo navegador (UI otimista). Obrigatório: é a chave de idempotência do reenvio. */
  clientMessageId: z.uuid(),
  replyToId: z.uuid().optional(),
});

/**
 * Atendente responde (ou escreve nota interna). Idempotente por `clientMessageId`: reenviar devolve a mesma
 * mensagem, mesmo com requisições simultâneas (o lock da conversa serializa e a unicidade do banco é a rede de segurança).
 */
export async function sendMessage(
  ctx: Ctx,
  actor: Actor,
  rawInput: unknown,
): Promise<{ message: MessageView; duplicate: boolean }> {
  assertCan(actor, 'conversations:reply');
  const parsed = sendMessageInput.safeParse(rawInput);
  if (!parsed.success)
    throw new DomainError(
      'invalid_input',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  const input = parsed.data;

  const attempt = () =>
    withTenant(ctx.db, actor.accountId, async (tx) => {
      const conv = await loadVisibleConversation(tx, actor, input.conversationId);
      await lock(tx, `conv:${conv.id}`);

      const [dup] = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.accountId, actor.accountId),
            eq(messages.clientMessageId, input.clientMessageId),
          ),
        )
        .limit(1);
      if (dup) {
        if (dup.conversationId !== conv.id)
          throw new DomainError('invalid_input', 'client_message_id já usado em outra conversa');
        return { message: toMessageView(dup), duplicate: true };
      }

      if (input.replyToId) {
        const [target] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.id, input.replyToId), eq(messages.conversationId, conv.id)))
          .limit(1);
        if (!target)
          throw new DomainError('invalid_input', 'mensagem citada não pertence à conversa');
      }

      const [row] = await tx
        .insert(messages)
        .values({
          accountId: actor.accountId,
          conversationId: conv.id,
          inboxId: conv.inboxId,
          direction: 'out',
          senderType: 'user',
          senderId: actor.userId,
          content: input.content,
          private: input.private,
          replyToId: input.replyToId ?? null,
          clientMessageId: input.clientMessageId,
          createdAt: nowMs,
        })
        .returning();
      if (!row) throw new Error('falha ao gravar mensagem');
      await tx
        .update(conversations)
        .set({ lastActivityAt: nowMs })
        .where(eq(conversations.id, conv.id));
      await enqueueEvent(tx, {
        accountId: actor.accountId,
        aggregateType: 'message',
        aggregateId: row.id,
        type: 'message.created',
        payload: {
          message_id: row.id,
          conversation_id: conv.id,
          inbox_id: conv.inboxId,
          private: input.private,
          direction: 'out',
        },
      });
      return { message: toMessageView(row), duplicate: false };
    });

  try {
    return await attempt();
  } catch (e) {
    // rede de segurança: se a unicidade do banco ganhar de uma corrida, a segunda tentativa cai no caminho "duplicada"
    if (uniqueViolation(e)) return attempt();
    throw e;
  }
}

// ---------- leitura ----------

const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');

export function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const at = new Date(iso ?? '');
  if (!iso || !id || Number.isNaN(at.getTime()))
    throw new DomainError('invalid_input', 'cursor inválido');
  return { at, id };
}

/** Histórico paginado (mais recentes primeiro). Notas internas aparecem para a equipe, que é quem chama aqui. */
export async function listMessages(
  ctx: Ctx,
  actor: Actor,
  conversationId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<{ items: MessageView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const before = opts.before ? decodeCursor(opts.before) : null;
  const rows = await withTenant(ctx.db, actor.accountId, async (tx) => {
    await loadVisibleConversation(tx, actor, conversationId);
    return tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          before
            ? or(
                lt(messages.createdAt, before.at),
                and(eq(messages.createdAt, before.at), lt(messages.id, before.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);
  });
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(toMessageView),
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export { encodeCursor };
