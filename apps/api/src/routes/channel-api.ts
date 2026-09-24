import { DomainError, MAX_CONTENT_LENGTH, receiveInboundMessage, type Ctx } from '@waychat/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { access } from '../types.js';

const body = z.object({
  inbox_id: z.uuid(),
  /** Quem está escrevendo no sistema do integrador. `external_id` é o id dele lá. */
  contact: z.object({
    external_id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    email: z.email().max(320).optional(),
    phone: z.string().trim().max(32).optional(),
  }),
  content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
  /** Id desta mensagem no sistema do integrador: reenviar com o mesmo valor não duplica. */
  external_id: z.string().trim().min(1).max(200).optional(),
});

const result = z.object({
  message_id: z.uuid(),
  conversation_id: z.uuid(),
  contact_id: z.uuid(),
  duplicate: z.boolean(),
});

/** A conta vem sempre da chave autenticada, nunca do corpo. */
function principalOf(req: FastifyRequest) {
  if (!req.apiKey) throw new DomainError('api_key_invalid');
  return req.apiKey;
}

export function channelApiRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/api/v1/messages',
    {
      // Por IP, como o limite global; teto maior porque é tráfego de servidor para servidor.
      config: {
        ...access.apiKey('messages:write'),
        rateLimit: { max: 600, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['channel-api'],
        security: [{ bearerAuth: [] }],
        body,
        response: { 200: result, 201: result },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const res = await receiveInboundMessage(ctx, {
        accountId: principalOf(req).accountId,
        inboxId: b.inbox_id,
        channelType: 'api',
        identity: {
          channel: 'api',
          externalId: b.contact.external_id,
          name: b.contact.name,
          email: b.contact.email ?? null,
          phone: b.contact.phone ?? null,
        },
        content: b.content,
        ...(b.external_id ? { sourceId: b.external_id } : {}),
      });
      return reply.status(res.duplicate ? 200 : 201).send({
        message_id: res.message.id,
        conversation_id: res.conversationId,
        contact_id: res.contactId,
        duplicate: res.duplicate,
      });
    },
  );
}
