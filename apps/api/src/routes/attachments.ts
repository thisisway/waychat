import {
  agentAttachmentUrl,
  completeUpload,
  getConversation,
  requestUpload,
  type Ctx,
} from '@waychat/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { access } from '../types.js';
import { actorOf } from './auth.js';

export const attachmentView = z.object({
  id: z.uuid(),
  fileName: z.string(),
  contentType: z.string().nullable(),
  size: z.number(),
  status: z.enum(['awaiting_upload', 'scanning', 'clean', 'infected', 'rejected']),
});

const uploadForm = z.object({ url: z.string(), fields: z.record(z.string(), z.string()) });
const idParam = z.object({ id: z.uuid() });

/**
 * Anexos do painel. Fluxo: (1) `POST /conversations/:id/attachments` devolve um formulário assinado; (2) o navegador
 * envia o arquivo direto ao S3; (3) `POST /attachments/:id/complete` confere o conteúdo e inicia a varredura;
 * (4) o anexo só pode ser enviado numa mensagem (`attachment_ids`) quando estiver `clean`.
 */
export function attachmentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/conversations/:id/attachments',
    {
      config: {
        ...access.permission('conversations:reply'),
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['attachments'],
        params: idParam,
        body: z.object({ file_name: z.string(), size: z.number() }),
        response: { 201: z.object({ attachment: attachmentView, upload: uploadForm }) },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      // getConversation aplica a regra de visibilidade: conversa de outra inbox responde 404
      const conv = await getConversation(ctx, actor, req.params.id);
      const res = await requestUpload(
        ctx,
        {
          accountId: actor.accountId,
          inboxId: conv.inbox.id,
          uploaderType: 'user',
          uploaderId: actor.userId,
        },
        { fileName: req.body.file_name, size: req.body.size },
      );
      return reply.status(201).send(res);
    },
  );

  r.post(
    '/attachments/:id/complete',
    {
      config: {
        ...access.permission('conversations:reply'),
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      schema: {
        tags: ['attachments'],
        params: idParam,
        response: { 200: z.object({ attachment: attachmentView }) },
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const attachment = await completeUpload(
        ctx,
        { accountId: actor.accountId, uploaderType: 'user', uploaderId: actor.userId },
        req.params.id,
      );
      return { attachment };
    },
  );

  r.get(
    '/attachments/:id/download',
    {
      config: access.permission('conversations:read'),
      schema: {
        tags: ['attachments'],
        params: idParam,
        response: { 200: z.object({ url: z.string() }) },
      },
    },
    async (req) => ({ url: await agentAttachmentUrl(ctx, actorOf(req), req.params.id) }),
  );
}
