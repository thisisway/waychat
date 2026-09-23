import {
  addLabel,
  conversationCounts,
  createCannedResponse,
  createLabel,
  deleteCannedResponse,
  deleteLabel,
  getConversation,
  listCannedResponses,
  listConversations,
  listLabels,
  listMessages,
  markConversationRead,
  PRIORITIES,
  removeLabel,
  sendMessage,
  STATUSES,
  updateCannedResponse,
  updateConversation,
  type Ctx,
} from '@waychat/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { access } from '../types.js';
import { actorOf } from './auth.js';

const ok = z.object({ ok: z.literal(true) });
const idParam = z.object({ id: z.uuid() });

const summary = z.object({
  id: z.uuid(),
  displayId: z.number(),
  inboxId: z.uuid(),
  status: z.enum(STATUSES),
  priority: z.enum(PRIORITIES),
  assigneeId: z.uuid().nullable(),
  contact: z.object({
    id: z.uuid(),
    name: z.string(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
  }),
  lastMessage: z.string().nullable(),
  lastActivityAt: z.date(),
  unreadCount: z.number(),
});

const detail = summary.extend({
  snoozedUntil: z.date().nullable(),
  resolvedAt: z.date().nullable(),
  createdAt: z.date(),
  inbox: z.object({ id: z.uuid(), name: z.string(), channelType: z.string() }),
  labels: z.array(z.object({ id: z.uuid(), name: z.string(), color: z.string() })),
});

const message = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  direction: z.enum(['in', 'out']),
  senderType: z.enum(['contact', 'user', 'bot', 'system']),
  senderId: z.uuid().nullable(),
  type: z.string(),
  content: z.string().nullable(),
  contentAttributes: z.record(z.string(), z.unknown()),
  private: z.boolean(),
  replyToId: z.uuid().nullable(),
  status: z.string(),
  clientMessageId: z.uuid().nullable(),
  createdAt: z.date(),
});

const canned = z.object({ id: z.uuid(), shortcut: z.string(), content: z.string() });
const label = z.object({ id: z.uuid(), name: z.string(), color: z.string() });

export function conversationRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/conversations',
    {
      config: access.permission('conversations:read'),
      schema: {
        tags: ['conversations'],
        querystring: z.object({
          status: z.enum(STATUSES).optional(),
          assignee: z.string().max(40).optional(),
          inbox_id: z.uuid().optional(),
          label_id: z.uuid().optional(),
          unread: z.stringbool().optional(),
          search: z.string().max(100).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          before: z.string().max(200).optional(),
        }),
        response: { 200: z.object({ items: z.array(summary), nextCursor: z.string().nullable() }) },
      },
    },
    (req) => {
      const q = req.query;
      return listConversations(ctx, actorOf(req), {
        limit: q.limit,
        ...(q.status ? { status: q.status } : {}),
        ...(q.assignee ? { assignee: q.assignee } : {}),
        ...(q.inbox_id ? { inboxId: q.inbox_id } : {}),
        ...(q.label_id ? { labelId: q.label_id } : {}),
        ...(q.unread ? { unreadOnly: true } : {}),
        ...(q.search ? { search: q.search } : {}),
        ...(q.before ? { before: q.before } : {}),
      });
    },
  );

  r.get(
    '/conversations/counts',
    {
      config: access.permission('conversations:read'),
      schema: {
        tags: ['conversations'],
        response: {
          200: z.object({
            all: z.number(),
            unassigned: z.number(),
            mine: z.number(),
            unread: z.number(),
          }),
        },
      },
    },
    (req) => conversationCounts(ctx, actorOf(req)),
  );

  r.get(
    '/conversations/:id',
    {
      config: access.permission('conversations:read'),
      schema: { tags: ['conversations'], params: idParam, response: { 200: detail } },
    },
    (req) => getConversation(ctx, actorOf(req), req.params.id),
  );

  r.patch(
    '/conversations/:id',
    {
      config: access.permission('conversations:manage'),
      schema: {
        tags: ['conversations'],
        params: idParam,
        body: z.object({
          status: z.enum(STATUSES).optional(),
          priority: z.enum(PRIORITIES).optional(),
          assignee_id: z.uuid().nullable().optional(),
          snoozed_until: z.coerce.date().optional(),
        }),
        response: { 200: detail },
      },
    },
    (req) => {
      const b = req.body;
      return updateConversation(ctx, actorOf(req), req.params.id, {
        ...(b.status !== undefined ? { status: b.status } : {}),
        ...(b.priority !== undefined ? { priority: b.priority } : {}),
        ...(b.assignee_id !== undefined ? { assigneeId: b.assignee_id } : {}),
        ...(b.snoozed_until !== undefined ? { snoozedUntil: b.snoozed_until } : {}),
      });
    },
  );

  r.post(
    '/conversations/:id/read',
    {
      config: access.permission('conversations:read'),
      schema: { tags: ['conversations'], params: idParam, response: { 200: ok } },
    },
    async (req) => {
      await markConversationRead(ctx, actorOf(req), req.params.id);
      return { ok: true as const };
    },
  );

  r.get(
    '/conversations/:id/messages',
    {
      config: access.permission('conversations:read'),
      schema: {
        tags: ['conversations'],
        params: idParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.string().max(200).optional(),
        }),
        response: { 200: z.object({ items: z.array(message), nextCursor: z.string().nullable() }) },
      },
    },
    (req) =>
      listMessages(ctx, actorOf(req), req.params.id, {
        limit: req.query.limit,
        ...(req.query.before ? { before: req.query.before } : {}),
      }),
  );

  // Idempotente: o mesmo client_message_id devolve a mensagem já criada (200 com duplicate=true), sem duplicar.
  r.post(
    '/conversations/:id/messages',
    {
      config: access.permission('conversations:reply'),
      schema: {
        tags: ['conversations'],
        params: idParam,
        body: z.object({
          content: z.string().max(10_000),
          client_message_id: z.uuid(),
          private: z.boolean().optional(),
          reply_to_id: z.uuid().optional(),
        }),
        response: {
          200: z.object({ message, duplicate: z.boolean() }),
          201: z.object({ message, duplicate: z.boolean() }),
        },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const res = await sendMessage(ctx, actorOf(req), {
        conversationId: req.params.id,
        content: b.content,
        clientMessageId: b.client_message_id,
        ...(b.private !== undefined ? { private: b.private } : {}),
        ...(b.reply_to_id ? { replyToId: b.reply_to_id } : {}),
      });
      return reply.status(res.duplicate ? 200 : 201).send(res);
    },
  );

  r.post(
    '/conversations/:id/labels/:labelId',
    {
      config: access.permission('conversations:manage'),
      schema: {
        tags: ['conversations'],
        params: z.object({ id: z.uuid(), labelId: z.uuid() }),
        response: { 200: ok },
      },
    },
    async (req) => {
      await addLabel(ctx, actorOf(req), req.params.id, req.params.labelId);
      return { ok: true as const };
    },
  );

  r.delete(
    '/conversations/:id/labels/:labelId',
    {
      config: access.permission('conversations:manage'),
      schema: {
        tags: ['conversations'],
        params: z.object({ id: z.uuid(), labelId: z.uuid() }),
        response: { 200: ok },
      },
    },
    async (req) => {
      await removeLabel(ctx, actorOf(req), req.params.id, req.params.labelId);
      return { ok: true as const };
    },
  );

  // ---- labels
  r.get(
    '/labels',
    {
      config: access.permission('conversations:read'),
      schema: { tags: ['labels'], response: { 200: z.object({ items: z.array(label) }) } },
    },
    async (req) => ({ items: await listLabels(ctx, actorOf(req)) }),
  );

  r.post(
    '/labels',
    {
      config: access.permission('labels:manage'),
      schema: {
        tags: ['labels'],
        body: z.object({ name: z.string().max(40), color: z.string().max(7).optional() }),
        response: { 201: label },
      },
    },
    async (req, reply) => reply.status(201).send(await createLabel(ctx, actorOf(req), req.body)),
  );

  r.delete(
    '/labels/:id',
    {
      config: access.permission('labels:manage'),
      schema: { tags: ['labels'], params: idParam, response: { 200: ok } },
    },
    async (req) => {
      await deleteLabel(ctx, actorOf(req), req.params.id);
      return { ok: true as const };
    },
  );

  // ---- respostas prontas
  r.get(
    '/canned-responses',
    {
      config: access.permission('conversations:read'),
      schema: {
        tags: ['canned-responses'],
        querystring: z.object({ search: z.string().max(60).optional() }),
        response: { 200: z.object({ items: z.array(canned) }) },
      },
    },
    async (req) => ({ items: await listCannedResponses(ctx, actorOf(req), req.query.search) }),
  );

  r.post(
    '/canned-responses',
    {
      config: access.permission('canned_responses:manage'),
      schema: {
        tags: ['canned-responses'],
        body: z.object({ shortcut: z.string().max(40), content: z.string().max(4000) }),
        response: { 201: canned },
      },
    },
    async (req, reply) =>
      reply.status(201).send(await createCannedResponse(ctx, actorOf(req), req.body)),
  );

  r.patch(
    '/canned-responses/:id',
    {
      config: access.permission('canned_responses:manage'),
      schema: {
        tags: ['canned-responses'],
        params: idParam,
        body: z.object({
          shortcut: z.string().max(40).optional(),
          content: z.string().max(4000).optional(),
        }),
        response: { 200: canned },
      },
    },
    (req) => updateCannedResponse(ctx, actorOf(req), req.params.id, req.body),
  );

  r.delete(
    '/canned-responses/:id',
    {
      config: access.permission('canned_responses:manage'),
      schema: { tags: ['canned-responses'], params: idParam, response: { 200: ok } },
    },
    async (req) => {
      await deleteCannedResponse(ctx, actorOf(req), req.params.id);
      return { ok: true as const };
    },
  );
}
