import {
  API_SCOPES,
  CHANNEL_TYPES,
  createApiKey,
  createInbox,
  deleteInbox,
  listApiKeys,
  listInboxes,
  listInboxMembers,
  revokeApiKey,
  rotateIdentitySecret,
  setInboxMembers,
  updateInbox,
  type Ctx,
} from '@waychat/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { access } from '../types.js';
import { actorOf } from './auth.js';

const ok = z.object({ ok: z.literal(true) });
const idParam = z.object({ id: z.uuid() });
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const inboxView = z.object({
  id: z.uuid(),
  name: z.string(),
  channelType: z.enum(CHANNEL_TYPES),
  publicKey: z.string(),
  enabled: z.boolean(),
  welcomeMessage: z.string().nullable(),
  primaryColor: z.string().nullable(),
  allowedOrigins: z.array(z.string()),
});

const apiKeyView = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.enum(API_SCOPES)),
  expiresAt: z.date().nullable(),
  lastUsedAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
});

export function inboxRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Lista "as minhas": quem tem inboxes:read vê todas, os demais só as de que são membros (filtro no caso de uso).
  r.get(
    '/inboxes',
    {
      config: access.self,
      schema: { tags: ['inboxes'], response: { 200: z.object({ items: z.array(inboxView) }) } },
    },
    async (req) => ({ items: await listInboxes(ctx, actorOf(req)) }),
  );

  r.post(
    '/inboxes',
    {
      config: access.permission('inboxes:manage'),
      schema: {
        tags: ['inboxes'],
        body: z.object({
          name: z.string().trim().min(2).max(80),
          channel_type: z.enum(CHANNEL_TYPES),
          welcome_message: z.string().max(500).optional(),
          primary_color: hexColor.optional(),
          allowed_origins: z.array(z.url()).max(20).optional(),
        }),
        response: {
          201: z.object({ inbox: inboxView, identity_secret: z.string().nullable() }),
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const res = await createInbox(ctx, actorOf(req), {
        name: b.name,
        channelType: b.channel_type,
        welcomeMessage: b.welcome_message,
        primaryColor: b.primary_color,
        allowedOrigins: b.allowed_origins,
      });
      return reply.status(201).send({ inbox: res.inbox, identity_secret: res.identitySecret });
    },
  );

  r.patch(
    '/inboxes/:id',
    {
      config: access.permission('inboxes:manage'),
      schema: {
        tags: ['inboxes'],
        params: idParam,
        body: z.object({
          name: z.string().trim().min(2).max(80).optional(),
          enabled: z.boolean().optional(),
          welcome_message: z.string().max(500).nullable().optional(),
          primary_color: hexColor.nullable().optional(),
          allowed_origins: z.array(z.url()).max(20).optional(),
        }),
        response: { 200: inboxView },
      },
    },
    (req) => {
      const b = req.body;
      return updateInbox(ctx, actorOf(req), req.params.id, {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        ...(b.welcome_message !== undefined ? { welcomeMessage: b.welcome_message } : {}),
        ...(b.primary_color !== undefined ? { primaryColor: b.primary_color } : {}),
        ...(b.allowed_origins !== undefined ? { allowedOrigins: b.allowed_origins } : {}),
      });
    },
  );

  r.post(
    '/inboxes/:id/identity-secret/rotate',
    {
      config: access.permission('inboxes:manage'),
      schema: {
        tags: ['inboxes'],
        params: idParam,
        response: { 200: z.object({ identity_secret: z.string() }) },
      },
    },
    async (req) => {
      const { identitySecret } = await rotateIdentitySecret(ctx, actorOf(req), req.params.id);
      return { identity_secret: identitySecret };
    },
  );

  r.delete(
    '/inboxes/:id',
    {
      config: access.permission('inboxes:manage'),
      schema: { tags: ['inboxes'], params: idParam, response: { 200: ok } },
    },
    async (req) => {
      await deleteInbox(ctx, actorOf(req), req.params.id);
      return { ok: true as const };
    },
  );

  r.get(
    '/inboxes/:id/members',
    {
      config: access.permission('inboxes:read'),
      schema: {
        tags: ['inboxes'],
        params: idParam,
        response: {
          200: z.object({
            items: z.array(z.object({ userId: z.uuid(), name: z.string(), email: z.string() })),
          }),
        },
      },
    },
    async (req) => ({ items: await listInboxMembers(ctx, actorOf(req), req.params.id) }),
  );

  r.put(
    '/inboxes/:id/members',
    {
      config: access.permission('inboxes:manage'),
      schema: {
        tags: ['inboxes'],
        params: idParam,
        body: z.object({ user_ids: z.array(z.uuid()).max(500) }),
        response: { 200: ok },
      },
    },
    async (req) => {
      await setInboxMembers(ctx, actorOf(req), req.params.id, req.body.user_ids);
      return { ok: true as const };
    },
  );

  // ---- chaves de API
  r.get(
    '/api-keys',
    {
      config: access.permission('api_keys:read'),
      schema: { tags: ['api-keys'], response: { 200: z.object({ items: z.array(apiKeyView) }) } },
    },
    async (req) => ({ items: await listApiKeys(ctx, actorOf(req)) }),
  );

  r.post(
    '/api-keys',
    {
      config: access.permission('api_keys:manage'),
      schema: {
        tags: ['api-keys'],
        body: z.object({
          name: z.string().trim().min(2).max(80),
          scopes: z.array(z.enum(API_SCOPES)).min(1),
          expires_at: z.coerce.date().optional(),
        }),
        response: { 201: z.object({ key: z.string(), api_key: apiKeyView }) },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const res = await createApiKey(ctx, actorOf(req), {
        name: b.name,
        scopes: b.scopes,
        ...(b.expires_at ? { expiresAt: b.expires_at } : {}),
      });
      return reply.status(201).send({ key: res.key, api_key: res.apiKey });
    },
  );

  r.delete(
    '/api-keys/:id',
    {
      config: access.permission('api_keys:manage'),
      schema: { tags: ['api-keys'], params: idParam, response: { 200: ok } },
    },
    async (req) => {
      await revokeApiKey(ctx, actorOf(req), req.params.id);
      return { ok: true as const };
    },
  );
}
