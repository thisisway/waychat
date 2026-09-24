import { schema, withTenant } from '@waychat/db';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { DomainError } from '../../../errors.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';
import { loadVisibleConversation } from '../../conversations/application/access.js';
import type { Visitor } from '../../widget/application/widget.js';
import { downloadUrlFor } from './attachments.js';

const { attachments, messages, conversations, contactIdentities } = schema;

/**
 * Link de download para um atendente: só se o anexo pertence a uma mensagem de uma conversa que ele pode ver
 * (a mesma regra de visibilidade da API de mensagens). Qualquer falha responde `not_found`.
 */
export async function agentAttachmentUrl(
  ctx: Ctx,
  actor: Actor,
  attachmentId: string,
): Promise<string> {
  assertCan(actor, 'conversations:read');
  const row = await withTenant(ctx.db, actor.accountId, async (tx) => {
    const [found] = await tx
      .select({ a: attachments, conversationId: messages.conversationId })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    if (!found) return null;
    await loadVisibleConversation(tx, actor, found.conversationId);
    return found.a;
  });
  if (!row) throw new DomainError('not_found');
  return downloadUrlFor(ctx, row);
}

/**
 * Link de download para o visitante: só arquivos da PRÓPRIA conversa (mensagens públicas) ou que ele mesmo
 * enviou. Nunca anexos de nota interna nem de outro visitante.
 */
export async function visitorAttachmentUrl(
  ctx: Ctx,
  visitor: Visitor,
  attachmentId: string,
): Promise<string> {
  const row = await withTenant(ctx.db, visitor.accountId, async (tx) => {
    const [own] = await tx
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.inboxId, visitor.inboxId),
          eq(attachments.uploaderType, 'visitor'),
          eq(attachments.uploaderId, visitor.externalId),
        ),
      )
      .limit(1);
    if (own) return own;
    const [reply] = await tx
      .select({ a: attachments })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .innerJoin(contactIdentities, eq(contactIdentities.contactId, conversations.contactId))
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(messages.private, false),
          eq(conversations.inboxId, visitor.inboxId),
          eq(contactIdentities.channel, 'widget'),
          eq(contactIdentities.externalId, visitor.externalId),
        ),
      )
      .limit(1);
    return reply?.a ?? null;
  });
  if (!row) throw new DomainError('not_found');
  return downloadUrlFor(ctx, row);
}
