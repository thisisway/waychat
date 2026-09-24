import {
  DomainError,
  openSessionInput,
  openWidgetSession,
  visitorMessages,
  visitorSend,
  visitorSendInput,
  type Ctx,
} from '@waychat/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { access } from '../types.js';

const message = z.object({
  id: z.uuid(),
  from: z.enum(['visitor', 'agent']),
  content: z.string(),
  created_at: z.date(),
  client_message_id: z.uuid().nullable(),
});

/** O visitante vem sempre do token assinado pelo hook de acesso, nunca do corpo. */
function visitorOf(req: FastifyRequest) {
  if (!req.visitor) throw new DomainError('invalid_token');
  return req.visitor;
}

const toDto = (m: {
  id: string;
  from: 'visitor' | 'agent';
  content: string;
  createdAt: Date;
  clientMessageId: string | null;
}) => ({
  id: m.id,
  from: m.from,
  content: m.content,
  created_at: m.createdAt,
  client_message_id: m.clientMessageId,
});

export function widgetRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/widget/v1/session',
    {
      // Chamada de qualquer site: quem pode abrir sessão é decidido pela lista de origens da inbox.
      config: { ...access.public, anyOrigin: true, rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['widget'],
        body: openSessionInput,
        response: {
          200: z.object({
            token: z.string(),
            expires_at: z.date(),
            visitor_id: z.string().nullable(),
            identified: z.boolean(),
            inbox: z.object({
              name: z.string(),
              welcome_message: z.string().nullable(),
              primary_color: z.string().nullable(),
            }),
          }),
        },
      },
    },
    async (req) => {
      const s = await openWidgetSession(ctx, req.headers.origin, req.body);
      return {
        token: s.token,
        expires_at: s.expiresAt,
        visitor_id: s.visitorId,
        identified: s.identified,
        inbox: {
          name: s.inbox.name,
          welcome_message: s.inbox.welcomeMessage,
          primary_color: s.inbox.primaryColor,
        },
      };
    },
  );

  r.get(
    '/widget/v1/messages',
    {
      config: access.visitor,
      schema: {
        tags: ['widget'],
        security: [{ bearerAuth: [] }],
        response: { 200: z.object({ items: z.array(message) }) },
      },
    },
    async (req) => ({ items: (await visitorMessages(ctx, visitorOf(req))).map(toDto) }),
  );

  r.post(
    '/widget/v1/messages',
    {
      config: { ...access.visitor, rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['widget'],
        security: [{ bearerAuth: [] }],
        body: visitorSendInput,
        response: { 200: z.object({ message, duplicate: z.boolean() }) },
      },
    },
    async (req) => {
      const res = await visitorSend(ctx, visitorOf(req), req.body);
      return { message: toDto(res.message), duplicate: res.duplicate };
    },
  );
}
