import {
  createContact,
  deleteContact,
  getContact,
  listContacts,
  updateContact,
  type Ctx,
} from '@waychat/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { access } from '../types.js';
import { actorOf } from './auth.js';

const ok = z.object({ ok: z.literal(true) });
const idParam = z.object({ id: z.uuid() });

const contactView = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// A normalização (e-mail em minúsculas, telefone E.164) e os limites ficam no caso de uso; aqui só o formato.
const body = z.object({
  name: z.string().min(1).max(200),
  email: z.string().max(254).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export function contactRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/contacts',
    {
      config: access.permission('contacts:read'),
      schema: {
        tags: ['contacts'],
        querystring: z.object({
          search: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          before: z.uuid().optional(),
        }),
        response: {
          200: z.object({ items: z.array(contactView), nextCursor: z.string().nullable() }),
        },
      },
    },
    (req) =>
      listContacts(ctx, actorOf(req), {
        limit: req.query.limit,
        ...(req.query.search ? { search: req.query.search } : {}),
        ...(req.query.before ? { before: req.query.before } : {}),
      }),
  );

  r.post(
    '/contacts',
    {
      config: access.permission('contacts:manage'),
      schema: { tags: ['contacts'], body, response: { 201: contactView } },
    },
    async (req, reply) => reply.status(201).send(await createContact(ctx, actorOf(req), req.body)),
  );

  r.get(
    '/contacts/:id',
    {
      config: access.permission('contacts:read'),
      schema: { tags: ['contacts'], params: idParam, response: { 200: contactView } },
    },
    (req) => getContact(ctx, actorOf(req), req.params.id),
  );

  r.patch(
    '/contacts/:id',
    {
      config: access.permission('contacts:manage'),
      schema: {
        tags: ['contacts'],
        params: idParam,
        body: body.partial(),
        response: { 200: contactView },
      },
    },
    (req) => updateContact(ctx, actorOf(req), req.params.id, req.body),
  );

  r.delete(
    '/contacts/:id',
    {
      config: access.permission('contacts:manage'),
      schema: { tags: ['contacts'], params: idParam, response: { 200: ok } },
    },
    async (req) => {
      await deleteContact(ctx, actorOf(req), req.params.id);
      return { ok: true as const };
    },
  );
}
