import {
  connectWhatsApp,
  getWhatsAppConnection,
  updateWhatsAppConnection,
  type Ctx,
} from '@waychat/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { access } from '../types.js';
import { actorOf } from './auth.js';

const settings = {
  opt_out_keywords: z.array(z.string()).optional(),
  opt_out_reply: z.string().nullable().optional(),
  send_read_receipts: z.boolean().optional(),
  send_typing_indicator: z.boolean().optional(),
  rate_limit_per_second: z.number().optional(),
};

const connectionView = z.object({
  inboxId: z.uuid(),
  phoneNumberId: z.string(),
  wabaId: z.string(),
  /** Últimos 4 caracteres: o valor completo nunca volta pela API. */
  accessToken: z.string(),
  appSecret: z.string(),
  verifyToken: z.string(),
  webhookPath: z.string(),
  optOutKeywords: z.array(z.string()),
  optOutReply: z.string().nullable(),
  sendReadReceipts: z.boolean(),
  sendTypingIndicator: z.boolean(),
  rateLimitPerSecond: z.number(),
  qualityRating: z.string().nullable(),
  messagingTier: z.string().nullable(),
});

const inboxSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  channelType: z.string(),
  publicKey: z.string(),
  enabled: z.boolean(),
});

/** Conexão do WhatsApp Cloud API (config cifrada, segredos mascarados). Só quem gerencia caixas de entrada. */
export function whatsappRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/inboxes/whatsapp',
    {
      config: access.permission('inboxes:manage'),
      schema: {
        tags: ['whatsapp'],
        body: z.object({
          name: z.string(),
          phone_number_id: z.string(),
          waba_id: z.string(),
          access_token: z.string(),
          app_secret: z.string(),
          ...settings,
        }),
        response: { 201: z.object({ inbox: inboxSummary, connection: connectionView }) },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const res = await connectWhatsApp(ctx, actorOf(req), {
        name: b.name,
        phoneNumberId: b.phone_number_id,
        wabaId: b.waba_id,
        accessToken: b.access_token,
        appSecret: b.app_secret,
        ...(b.opt_out_keywords ? { optOutKeywords: b.opt_out_keywords } : {}),
        ...(b.opt_out_reply !== undefined ? { optOutReply: b.opt_out_reply } : {}),
        ...(b.send_read_receipts !== undefined ? { sendReadReceipts: b.send_read_receipts } : {}),
        ...(b.send_typing_indicator !== undefined
          ? { sendTypingIndicator: b.send_typing_indicator }
          : {}),
        ...(b.rate_limit_per_second !== undefined
          ? { rateLimitPerSecond: b.rate_limit_per_second }
          : {}),
      });
      return reply.status(201).send(res);
    },
  );

  r.get(
    '/inboxes/:id/whatsapp',
    {
      config: access.permission('inboxes:manage'),
      schema: {
        tags: ['whatsapp'],
        params: z.object({ id: z.uuid() }),
        response: { 200: connectionView },
      },
    },
    async (req) => getWhatsAppConnection(ctx, actorOf(req), req.params.id),
  );

  r.patch(
    '/inboxes/:id/whatsapp',
    {
      config: access.permission('inboxes:manage'),
      schema: {
        tags: ['whatsapp'],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          phone_number_id: z.string().optional(),
          waba_id: z.string().optional(),
          access_token: z.string().optional(),
          app_secret: z.string().optional(),
          rotate_verify_token: z.boolean().optional(),
          ...settings,
        }),
        response: { 200: connectionView },
      },
    },
    async (req) => {
      const b = req.body;
      return updateWhatsAppConnection(ctx, actorOf(req), req.params.id, {
        ...(b.phone_number_id ? { phoneNumberId: b.phone_number_id } : {}),
        ...(b.waba_id ? { wabaId: b.waba_id } : {}),
        ...(b.access_token ? { accessToken: b.access_token } : {}),
        ...(b.app_secret ? { appSecret: b.app_secret } : {}),
        ...(b.rotate_verify_token ? { rotateVerifyToken: true } : {}),
        ...(b.opt_out_keywords ? { optOutKeywords: b.opt_out_keywords } : {}),
        ...(b.opt_out_reply !== undefined ? { optOutReply: b.opt_out_reply } : {}),
        ...(b.send_read_receipts !== undefined ? { sendReadReceipts: b.send_read_receipts } : {}),
        ...(b.send_typing_indicator !== undefined
          ? { sendTypingIndicator: b.send_typing_indicator }
          : {}),
        ...(b.rate_limit_per_second !== undefined
          ? { rateLimitPerSecond: b.rate_limit_per_second }
          : {}),
      });
    },
  );
}
