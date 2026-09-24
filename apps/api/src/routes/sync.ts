import { currentCursor, listEventsSince, type Ctx } from '@waychat/core';
import { eventEnvelopeSchema } from '@waychat/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { access } from '../types.js';
import { actorOf } from './auth.js';

export function syncRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /**
   * Recuperação após reconexão: "me dê tudo desde o cursor N". Sem `since`, devolve só o cursor atual (cliente novo).
   * Só entrega eventos que o usuário também poderia obter pela API (mesma regra do WebSocket).
   */
  r.get(
    '/sync',
    {
      config: access.self,
      schema: {
        tags: ['sync'],
        querystring: z.object({
          since: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
        response: {
          200: z.object({
            events: z.array(eventEnvelopeSchema),
            cursor: z.number(),
            has_more: z.boolean(),
          }),
        },
      },
    },
    async (req) => {
      const actor = actorOf(req);
      if (req.query.since === undefined) {
        return { events: [], cursor: await currentCursor(ctx, actor), has_more: false };
      }
      const res = await listEventsSince(ctx, actor, req.query.since, req.query.limit);
      return { events: res.events, cursor: res.cursor, has_more: res.hasMore };
    },
  );
}
