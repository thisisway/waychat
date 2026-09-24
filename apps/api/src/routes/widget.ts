import {
  completeUpload,
  DomainError,
  openSessionInput,
  openWidgetSession,
  requestUpload,
  visitorAttachmentUrl,
  visitorMessages,
  visitorSend,
  visitorSendInput,
  type Ctx,
  type Visitor,
  type VisitorMessage,
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
  attachments: z.array(
    z.object({
      id: z.uuid(),
      file_name: z.string(),
      content_type: z.string().nullable(),
      size: z.number(),
    }),
  ),
});

/** O visitante vem sempre do token assinado pelo hook de acesso, nunca do corpo. */
function visitorOf(req: FastifyRequest) {
  if (!req.visitor) throw new DomainError('invalid_token');
  return req.visitor;
}

const toDto = (m: VisitorMessage) => ({
  id: m.id,
  from: m.from,
  content: m.content,
  created_at: m.createdAt,
  client_message_id: m.clientMessageId,
  attachments: m.attachments.map((a) => ({
    id: a.id,
    file_name: a.fileName,
    content_type: a.contentType,
    size: a.size,
  })),
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

  // Anexos do visitante: mesmo fluxo do painel (URL assinada -> envio direto ao S3 -> conclusão -> varredura).
  const subjectOf = (v: Visitor) => ({
    accountId: v.accountId,
    uploaderType: 'visitor' as const,
    uploaderId: v.externalId,
  });
  const attachment = z.object({
    id: z.uuid(),
    file_name: z.string(),
    content_type: z.string().nullable(),
    size: z.number(),
    status: z.enum(['awaiting_upload', 'scanning', 'clean', 'infected', 'rejected']),
  });
  const toAttachmentDto = (a: {
    id: string;
    fileName: string;
    contentType: string | null;
    size: number;
    status: 'awaiting_upload' | 'scanning' | 'clean' | 'infected' | 'rejected';
  }) => ({
    id: a.id,
    file_name: a.fileName,
    content_type: a.contentType,
    size: a.size,
    status: a.status,
  });

  r.post(
    '/widget/v1/attachments',
    {
      config: { ...access.visitor, rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['widget'],
        security: [{ bearerAuth: [] }],
        body: z.object({ file_name: z.string(), size: z.number() }),
        response: {
          201: z.object({
            attachment,
            upload: z.object({ url: z.string(), fields: z.record(z.string(), z.string()) }),
          }),
        },
      },
    },
    async (req, reply) => {
      const v = visitorOf(req);
      const res = await requestUpload(
        ctx,
        { ...subjectOf(v), inboxId: v.inboxId },
        { fileName: req.body.file_name, size: req.body.size },
      );
      return reply
        .status(201)
        .send({ attachment: toAttachmentDto(res.attachment), upload: res.upload });
    },
  );

  r.post(
    '/widget/v1/attachments/:id/complete',
    {
      config: { ...access.visitor, rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        tags: ['widget'],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid() }),
        response: { 200: z.object({ attachment }) },
      },
    },
    async (req) => ({
      attachment: toAttachmentDto(
        await completeUpload(ctx, subjectOf(visitorOf(req)), req.params.id),
      ),
    }),
  );

  r.get(
    '/widget/v1/attachments/:id/url',
    {
      config: access.visitor,
      schema: {
        tags: ['widget'],
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid() }),
        response: { 200: z.object({ url: z.string() }) },
      },
    },
    async (req) => ({ url: await visitorAttachmentUrl(ctx, visitorOf(req), req.params.id) }),
  );
}
