import type {
  OutboundContent,
  OutboundMedia,
  OutboundMessage,
  SendResult,
} from '@waychat/channels';
import { graphRequest, type GraphConfig } from './graph.js';

/** `content.type === 'template'`: sincronização e envio de templates ficam para o passo 7. */
export class UnsupportedContentError extends Error {
  constructor(contentType: string) {
    super(`tipo de conteúdo ainda não suportado no envio: ${contentType}`);
    this.name = 'UnsupportedContentError';
  }
}

const media = (m: OutboundMedia) => ('id' in m ? { id: m.id } : { link: m.link });

function payloadFor(content: OutboundContent): Record<string, unknown> {
  switch (content.type) {
    case 'text':
      return {
        type: 'text',
        text: { body: content.body, preview_url: content.previewUrl ?? false },
      };
    case 'image':
    case 'video':
    case 'sticker':
      return {
        type: content.type,
        [content.type]: {
          ...media(content.media),
          ...(content.caption ? { caption: content.caption } : {}),
        },
      };
    case 'document':
      return {
        type: 'document',
        document: {
          ...media(content.media),
          ...(content.caption ? { caption: content.caption } : {}),
          ...(content.fileName ? { filename: content.fileName } : {}),
        },
      };
    case 'audio':
      // a Cloud API não aceita legenda em áudio
      return { type: 'audio', audio: media(content.media) };
    case 'location':
      return {
        type: 'location',
        location: {
          latitude: content.latitude,
          longitude: content.longitude,
          ...(content.name ? { name: content.name } : {}),
          ...(content.address ? { address: content.address } : {}),
        },
      };
    case 'contacts':
      return {
        type: 'contacts',
        contacts: content.contacts.map((c) => ({
          name: { formatted_name: c.name },
          phones: c.phones.map((p) => ({
            phone: p.phone,
            ...(p.waId ? { wa_id: p.waId } : {}),
            ...(p.kind ? { type: p.kind } : {}),
          })),
          emails: c.emails.map((e) => ({ email: e })),
        })),
      };
    case 'reaction':
      // string vazia remove a reação; a Meta não aceita `null` aqui
      return {
        type: 'reaction',
        reaction: { message_id: content.targetProviderId, emoji: content.emoji ?? '' },
      };
    case 'interactive_buttons':
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(content.header ? { header: { type: 'text', text: content.header } } : {}),
          body: { text: content.body },
          ...(content.footer ? { footer: { text: content.footer } } : {}),
          action: {
            buttons: content.buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      };
    case 'interactive_list':
      return {
        type: 'interactive',
        interactive: {
          type: 'list',
          ...(content.header ? { header: { type: 'text', text: content.header } } : {}),
          body: { text: content.body },
          ...(content.footer ? { footer: { text: content.footer } } : {}),
          action: {
            button: content.buttonLabel,
            sections: content.sections.map((s) => ({
              title: s.title,
              rows: s.rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {}),
              })),
            })),
          },
        },
      };
    case 'interactive_cta_url':
      return {
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          ...(content.header ? { header: { type: 'text', text: content.header } } : {}),
          body: { text: content.body },
          ...(content.footer ? { footer: { text: content.footer } } : {}),
          action: {
            name: 'cta_url',
            parameters: { display_text: content.label, url: content.url },
          },
        },
      };
    case 'template':
      throw new UnsupportedContentError('template');
  }
}

interface SendResponse {
  messages?: { id?: string }[];
}

/**
 * Envia pela Cloud API. `msg.opaque` (o id da NOSSA mensagem) vai em `biz_opaque_callback_data`: é o que a Meta
 * devolve nos webhooks de status, e o que permite reconciliar um envio duvidoso sem uma chave de idempotência
 * própria do provedor (ADR 0011).
 */
export async function send(msg: OutboundMessage, cfg: GraphConfig): Promise<SendResult> {
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: msg.to,
    biz_opaque_callback_data: msg.opaque,
    ...(msg.replyToProviderId ? { context: { message_id: msg.replyToProviderId } } : {}),
    ...payloadFor(msg.content),
  };
  const res = await graphRequest(cfg, 'messages', { method: 'POST', body });
  const data = (await res.json()) as SendResponse;
  const providerMessageId = data.messages?.[0]?.id;
  if (!providerMessageId) throw new Error('a Graph API não devolveu o id da mensagem enviada');
  return { providerMessageId };
}
