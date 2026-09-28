import type { DeliveryStatus, InboundContent, MediaRef, NormalizedEvent } from '@waychat/channels';
import { schema, withTenant } from '@waychat/db';
import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { attachInboundMedia } from '../../attachments/application/attachments.js';
import { receiveInboundMessage } from '../../conversations/application/messages.js';
import { enqueueEvent } from '../../events/application/enqueue.js';
import type { WhatsAppTarget } from '../../inbox/application/whatsapp.js';

const { messages, contactOptOuts } = schema;

/** Mídia já baixada da Graph API pelo chamador (o core não fala com a Meta). */
export interface FetchedInboundMedia {
  fileName: string;
  buffer: Buffer;
}

export interface MappedWhatsAppContent {
  /** Vai em `messages.type`. */
  type: string;
  /** Vai em `messages.content` (texto livre, legenda, título da resposta rápida...). */
  content: string;
  contentAttributes: Record<string, unknown>;
  /** Presente para imagem/vídeo/áudio/documento/figurinha: precisa ser baixada e anexada. */
  media: MediaRef | null;
}

/**
 * Do formato do WhatsApp para o que o WayChat grava. Pura (sem I/O): fácil de testar cada tipo de conteúdo
 * isoladamente. `content` nunca fica `undefined`; tipos sem texto natural (localização, contatos, reação...)
 * levam os dados em `contentAttributes` e o texto vazio.
 */
export function mapWhatsAppContent(c: InboundContent): MappedWhatsAppContent {
  switch (c.type) {
    case 'text':
      return { type: 'text', content: c.body, contentAttributes: {}, media: null };
    case 'image':
    case 'video':
    case 'document':
    case 'sticker':
      return {
        type: c.type,
        content: c.caption ?? '',
        contentAttributes:
          c.type === 'sticker' && c.animated !== undefined ? { animated: c.animated } : {},
        media: c.media,
      };
    case 'audio':
      // WhatsApp não tem um tipo "voice" próprio: é `audio` com a flag `voice` (ADR do player de voz na Fase 2).
      return {
        type: c.voice ? 'voice' : 'audio',
        content: '',
        contentAttributes: {},
        media: c.media,
      };
    case 'location':
      return {
        type: 'location',
        content: '',
        contentAttributes: {
          latitude: c.latitude,
          longitude: c.longitude,
          ...(c.name ? { name: c.name } : {}),
          ...(c.address ? { address: c.address } : {}),
        },
        media: null,
      };
    case 'contacts':
      return {
        type: 'contacts',
        content: '',
        contentAttributes: { contacts: c.contacts },
        media: null,
      };
    case 'reaction':
      return {
        type: 'reaction',
        content: c.emoji ?? '',
        contentAttributes: { target_provider_id: c.targetProviderId, emoji: c.emoji },
        media: null,
      };
    case 'button_reply':
    case 'list_reply':
      return {
        type: c.type,
        content: c.title,
        contentAttributes: {
          reply_id: c.replyId,
          ...(c.type === 'list_reply' && c.description ? { description: c.description } : {}),
        },
        media: null,
      };
    case 'button':
      return {
        type: 'button',
        content: c.text,
        contentAttributes: { payload: c.payload },
        media: null,
      };
    case 'unsupported':
      return {
        type: 'unsupported',
        content: '',
        contentAttributes: {
          provider_type: c.providerType,
          ...(c.detail ? { detail: c.detail } : {}),
        },
        media: null,
      };
  }
}

/** Remove acento e caixa antes de comparar: "Sair", "SAIR", "sair" e "sáir" são a mesma palavra. */
const normalizeKeyword = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();

/** Texto igual (não "contém"): "vou sair de férias" não é opt-out. */
function matchesOptOut(text: string, keywords: readonly string[]): boolean {
  const n = normalizeKeyword(text);
  return n.length > 0 && keywords.some((k) => normalizeKeyword(k) === n);
}

async function recordOptOut(
  ctx: Ctx,
  target: WhatsAppTarget,
  contactId: string,
  keyword: string,
): Promise<void> {
  await withTenant(ctx.db, target.accountId, (tx) =>
    tx
      .insert(contactOptOuts)
      .values({
        accountId: target.accountId,
        contactId,
        channel: 'whatsapp',
        keyword: normalizeKeyword(keyword),
      })
      .onConflictDoUpdate({
        target: [contactOptOuts.accountId, contactOptOuts.contactId, contactOptOuts.channel],
        set: { keyword: normalizeKeyword(keyword), optedOutAt: ctx.now(), optedInAt: null },
      }),
  );
  // A confirmação automática ao cliente ("você não receberá mais mensagens") depende do envio (passo 6):
  // aqui só registra. Ver docs/backlog.md.
}

/**
 * Mensagem de entrada do WhatsApp. Reaproveita o pipeline do widget/canal API (contato, conversa, idempotência
 * por `sourceId`); a diferença é o tipo/conteúdo estruturado e a mídia, que o WayChat não pede de volta ao
 * cliente — o chamador (worker) já baixou os bytes da Graph API antes de chamar esta função.
 */
export async function processWhatsAppMessage(
  ctx: Ctx,
  target: WhatsAppTarget,
  event: Extract<NormalizedEvent, { kind: 'message' }>,
  media?: FetchedInboundMedia,
): Promise<void> {
  const mapped = mapWhatsAppContent(event.content);
  const optOut =
    mapped.type === 'text' && matchesOptOut(mapped.content, target.config.optOutKeywords);

  // Resposta citada: a Meta só deixa citar uma mensagem do mesmo fio, então basta achar pelo id na inbox
  // (não precisa confirmar o contato — ver ADR 0010 para o raciocínio completo).
  let replyToId: string | undefined;
  const quotedProviderId = event.replyToProviderId;
  if (quotedProviderId) {
    const found = await withTenant(ctx.db, target.accountId, async (tx) => {
      const [r] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.inboxId, target.inboxId), eq(messages.sourceId, quotedProviderId)))
        .limit(1);
      return r?.id;
    });
    if (found) replyToId = found;
  }

  const result = await receiveInboundMessage(ctx, {
    accountId: target.accountId,
    inboxId: target.inboxId,
    channelType: 'whatsapp',
    identity: {
      channel: 'whatsapp',
      externalId: event.from.id,
      name: event.from.name ?? event.from.id,
    },
    content: mapped.content,
    sourceId: event.providerId,
    contentAttributes: mapped.contentAttributes,
    type: mapped.type,
    allowEmpty: true,
    ...(replyToId ? { replyToId } : {}),
  });

  // Reentrega/job repetido: a mensagem já existe. Não baixa mídia de novo nem registra o opt-out outra vez.
  if (result.duplicate) return;

  if (mapped.media && media) {
    await attachInboundMedia(ctx, {
      accountId: target.accountId,
      inboxId: target.inboxId,
      messageId: result.message.id,
      uploaderId: event.from.id,
      fileName: media.fileName,
      buffer: media.buffer,
    });
  }
  if (optOut) await recordOptOut(ctx, target, result.contactId, mapped.content);
}

/** Ordem de avanço da entrega. `failed` é tratado à parte: vale a qualquer momento antes de `delivered`. */
const STATUS_ORDER = ['queued', 'sending', 'sent', 'delivered', 'read'] as const;

/** Nunca deixa um status "andar para trás" (webhooks de status podem chegar fora de ordem). */
function advancesStatus(current: string, incoming: DeliveryStatus): boolean {
  if (current === 'failed') return false; // terminal
  if (incoming === 'failed') return current !== 'delivered' && current !== 'read';
  const curIdx = STATUS_ORDER.indexOf(current as (typeof STATUS_ORDER)[number]);
  return STATUS_ORDER.indexOf(incoming) > curIdx;
}

/** Status de entrega de uma mensagem que ENVIAMOS (`source_id` = wamid, gravado no passo 6). */
export async function applyWhatsAppStatus(
  ctx: Ctx,
  target: WhatsAppTarget,
  event: Extract<NormalizedEvent, { kind: 'status' }>,
): Promise<void> {
  await withTenant(ctx.db, target.accountId, async (tx) => {
    const [row] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.inboxId, target.inboxId),
          eq(messages.sourceId, event.providerId),
          eq(messages.direction, 'out'),
        ),
      )
      .limit(1);
    if (!row || !advancesStatus(row.status, event.status)) return;

    await tx
      .update(messages)
      .set({
        status: event.status,
        ...(event.status === 'failed' && event.error
          ? { error: event.error.message, errorCode: String(event.error.code) }
          : {}),
      })
      .where(eq(messages.id, row.id));
    await enqueueEvent(tx, {
      accountId: target.accountId,
      aggregateType: 'message',
      aggregateId: row.id,
      type: 'message.updated',
      payload: {
        message_id: row.id,
        conversation_id: row.conversationId,
        inbox_id: target.inboxId,
        fields: ['status'],
      },
    });
  });
}

/**
 * Roteador de um evento já deduplicado (`inbound_events`). `template_status` (sincronização de templates) e
 * `quality` (rating/tier do número) ficam para os passos 7 e 9 — aqui só mensagem e status de entrega.
 */
export async function processWhatsAppEvent(
  ctx: Ctx,
  target: WhatsAppTarget,
  event: NormalizedEvent,
  media?: FetchedInboundMedia,
): Promise<void> {
  switch (event.kind) {
    case 'message':
      return processWhatsAppMessage(ctx, target, event, media);
    case 'status':
      return applyWhatsAppStatus(ctx, target, event);
    case 'template_status':
    case 'quality':
      return;
  }
}
