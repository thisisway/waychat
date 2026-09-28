import type { OutboundContent } from '@waychat/channels';
import { schema, withTenant, type Tx } from '@waychat/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { downloadUrlFor } from '../../attachments/application/attachments.js';
import { enqueueEvent } from '../../events/application/enqueue.js';
import { toMessageView, type MessageView } from '../../conversations/application/messages.js';

const { messages, conversations, contactIdentities, attachments } = schema;

/** Espelha o lock de `messages.ts`: serializa quem disputa o envio da MESMA mensagem. */
async function lock(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Só uma tentativa de envio já ambígua (chamamos a Graph API e não sabemos o resultado) pede espera. */
export class SendPendingError extends Error {
  constructor() {
    super('envio ainda ambíguo: aguardando o webhook de status confirmar');
    this.name = 'SendPendingError';
  }
}

type AttachmentRow = typeof attachments.$inferSelect;

export interface ClaimedSend {
  to: string;
  message: MessageView;
  attachment: AttachmentRow | null;
  replyToProviderId?: string;
}

/**
 * Reivindica o envio de uma mensagem de saída (ADR 0011): a única transação que decide o que fazer.
 *  - já resolvida (`sent`/`delivered`/`read`/`failed`) → `null`, nada a fazer;
 *  - `sending` com `source_id` já gravado → o passo 3 do envio anterior não terminou de marcar `sent`; conclui
 *    agora e devolve `null` (idempotente: um evento `message.updated` sai daqui, não de um novo envio);
 *  - `sending` sem `source_id` e ainda dentro da janela de espera → lança `SendPendingError` (o chamador deixa
 *    o job falhar; o BullMQ tenta de novo mais tarde, dando tempo do webhook de status chegar);
 *  - `queued`, ou `sending` sem `source_id` já fora da janela → marca `sending`, soma uma tentativa e devolve
 *    os dados para a chamada de verdade à Graph API.
 */
export async function claimWhatsAppSend(
  ctx: Ctx,
  accountId: string,
  messageId: string,
  opts: { pastWaitWindow: boolean },
): Promise<ClaimedSend | null> {
  return withTenant(ctx.db, accountId, async (tx) => {
    await lock(tx, `send:${messageId}`);
    const [row] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1);
    if (!row || row.direction !== 'out') return null;
    if (
      row.status === 'sent' ||
      row.status === 'delivered' ||
      row.status === 'read' ||
      row.status === 'failed'
    )
      return null;

    if (row.status === 'sending' && row.sourceId) {
      await finalizeSent(tx, accountId, row);
      return null;
    }
    if (row.status === 'sending' && !row.sourceId && !opts.pastWaitWindow) {
      throw new SendPendingError();
    }

    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, row.conversationId))
      .limit(1);
    if (!conv) throw new Error('conversa não encontrada para o envio');
    const [identity] = await tx
      .select()
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.contactId, conv.contactId),
          eq(contactIdentities.channel, 'whatsapp'),
        ),
      )
      .limit(1);
    if (!identity) throw new Error('o contato não tem identidade no WhatsApp');

    let replyToProviderId: string | undefined;
    if (row.replyToId) {
      const [quoted] = await tx
        .select({ sourceId: messages.sourceId })
        .from(messages)
        .where(eq(messages.id, row.replyToId))
        .limit(1);
      if (quoted?.sourceId) replyToProviderId = quoted.sourceId;
    }

    const attRows = await tx.select().from(attachments).where(eq(attachments.messageId, row.id));
    const clean = attRows.filter((a) => a.status === 'clean');
    if (clean.length > 1) {
      await tx
        .update(messages)
        .set({
          status: 'failed',
          error: 'O WhatsApp só aceita um anexo por mensagem.',
          errorCode: 'too_many_attachments',
        })
        .where(eq(messages.id, messageId));
      return null;
    }

    await tx
      .update(messages)
      .set({ status: 'sending', attempts: sql`${messages.attempts} + 1` })
      .where(eq(messages.id, messageId));

    return {
      to: identity.externalId,
      message: toMessageView(row),
      attachment: clean[0] ?? null,
      ...(replyToProviderId ? { replyToProviderId } : {}),
    };
  });
}

async function finalizeSent(
  tx: Tx,
  accountId: string,
  row: typeof messages.$inferSelect,
): Promise<void> {
  await tx.update(messages).set({ status: 'sent' }).where(eq(messages.id, row.id));
  await enqueueEvent(tx, {
    accountId,
    aggregateType: 'message',
    aggregateId: row.id,
    type: 'message.updated',
    payload: {
      message_id: row.id,
      conversation_id: row.conversationId,
      inbox_id: row.inboxId,
      fields: ['status'],
    },
  });
}

const whatsappKindFor = (contentType: string): 'image' | 'video' | 'audio' | 'document' => {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'document';
};

/**
 * Monta o conteúdo para a Graph API. O link do anexo é uma URL assinada de curta duração (a mesma do download
 * pelo painel) — funciona porque a Meta busca a mídia quase na hora do envio.
 * ponytail: link com TTL curto em vez de subir para a biblioteca de mídia da Meta primeiro (evitaria depender do
 * nosso S3 estar no ar); trocar se downloads atrasados começarem a falhar.
 */
export async function outboundContentFor(ctx: Ctx, claim: ClaimedSend): Promise<OutboundContent> {
  if (!claim.attachment) return { type: 'text', body: claim.message.content ?? '' };
  if (claim.attachment.status !== 'clean' || !claim.attachment.contentType)
    throw new Error('o anexo ainda não está pronto para envio');
  const link = await downloadUrlFor(ctx, claim.attachment);
  const kind = whatsappKindFor(claim.attachment.contentType);
  const caption = claim.message.content?.trim() ? claim.message.content : undefined;
  if (kind === 'audio') return { type: 'audio', media: { link } };
  if (kind === 'document')
    return {
      type: 'document',
      media: { link },
      fileName: claim.attachment.fileName,
      ...(caption ? { caption } : {}),
    };
  return { type: kind, media: { link }, ...(caption ? { caption } : {}) };
}

async function updateResolved(
  ctx: Ctx,
  accountId: string,
  messageId: string,
  set: Partial<typeof messages.$inferInsert>,
): Promise<void> {
  await withTenant(ctx.db, accountId, async (tx) => {
    const [row] = await tx
      .update(messages)
      .set(set)
      .where(and(eq(messages.id, messageId), eq(messages.status, 'sending')))
      .returning();
    if (!row) return; // já resolvido por outra via (corrida) — idempotente
    await enqueueEvent(tx, {
      accountId,
      aggregateType: 'message',
      aggregateId: messageId,
      type: 'message.updated',
      payload: {
        message_id: messageId,
        conversation_id: row.conversationId,
        inbox_id: row.inboxId,
        fields: ['status'],
      },
    });
  });
}

/** A Graph API aceitou o envio: grava o wamid (chave de status pelo `source_id`, como as mensagens de entrada). */
export const recordWhatsAppSent = (
  ctx: Ctx,
  accountId: string,
  messageId: string,
  providerMessageId: string,
) =>
  updateResolved(ctx, accountId, messageId, {
    sourceId: providerMessageId,
    status: 'sent',
    error: null,
    errorCode: null,
  });

/** Falha definitiva (Meta recusou, ou nem chegou a tentar): não adianta repetir. */
export const recordWhatsAppFailed = (
  ctx: Ctx,
  accountId: string,
  messageId: string,
  code: string,
  message: string,
) =>
  updateResolved(ctx, accountId, messageId, { status: 'failed', error: message, errorCode: code });
