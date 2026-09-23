import {
  addMember,
  changeMemberRole,
  createRole,
  deleteRole,
  getAccount,
  listAuditLogs,
  listMembers,
  listRoles,
  removeMember,
  updateAccount,
  updateRole,
  type Ctx,
} from '@waychat/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { access } from '../types.js';
import { actorOf } from './auth.js';

const ok = z.object({ ok: z.literal(true) });
const idParam = z.object({ id: z.uuid() });
const permissionList = z.array(z.string().max(64)).max(100);

export function adminRoutes(app: FastifyInstance, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---- conta
  r.get(
    '/account',
    {
      config: access.permission('account:read'),
      schema: {
        tags: ['account'],
        response: {
          200: z.object({
            id: z.uuid(),
            name: z.string(),
            slug: z.string(),
            require2fa: z.boolean(),
          }),
        },
      },
    },
    (req) => getAccount(ctx, actorOf(req)),
  );

  r.patch(
    '/account',
    {
      config: access.permission('account:update'),
      schema: {
        tags: ['account'],
        body: z.object({
          name: z.string().trim().min(2).max(80).optional(),
          require2fa: z.boolean().optional(),
        }),
        response: { 200: ok },
      },
    },
    async (req) => {
      await updateAccount(ctx, actorOf(req), {
        ...(req.body.name !== undefined ? { name: req.body.name } : {}),
        ...(req.body.require2fa !== undefined ? { require2fa: req.body.require2fa } : {}),
      });
      return { ok: true as const };
    },
  );

  // ---- membros
  r.get(
    '/members',
    {
      config: access.permission('members:read'),
      schema: {
        tags: ['members'],
        response: {
          200: z.object({
            items: z.array(
              z.object({
                userId: z.uuid(),
                name: z.string(),
                email: z.string(),
                roleId: z.uuid(),
                roleName: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => ({ items: await listMembers(ctx, actorOf(req)) }),
  );

  r.post(
    '/members',
    {
      config: access.permission('members:manage'),
      schema: {
        tags: ['members'],
        body: z.object({
          email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
          name: z.string().trim().min(1).max(120),
          password: z.string().min(1).max(128),
          role_id: z.uuid(),
        }),
        response: { 201: z.object({ user_id: z.uuid(), created: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const res = await addMember(ctx, actorOf(req), {
        email: b.email,
        name: b.name,
        password: b.password,
        roleId: b.role_id,
      });
      return reply.status(201).send({ user_id: res.userId, created: res.created });
    },
  );

  r.patch(
    '/members/:id',
    {
      config: access.permission('members:manage'),
      schema: {
        tags: ['members'],
        params: idParam,
        body: z.object({ role_id: z.uuid() }),
        response: { 200: ok },
      },
    },
    async (req) => {
      await changeMemberRole(ctx, actorOf(req), req.params.id, req.body.role_id);
      return { ok: true as const };
    },
  );

  r.delete(
    '/members/:id',
    {
      config: access.permission('members:manage'),
      schema: { tags: ['members'], params: idParam, response: { 200: ok } },
    },
    async (req) => {
      await removeMember(ctx, actorOf(req), req.params.id);
      return { ok: true as const };
    },
  );

  // ---- papéis
  r.get(
    '/roles',
    {
      config: access.permission('roles:read'),
      schema: {
        tags: ['roles'],
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.uuid(),
                name: z.string(),
                isSystem: z.boolean(),
                permissions: z.array(z.string()),
              }),
            ),
          }),
        },
      },
    },
    async (req) => ({ items: await listRoles(ctx, actorOf(req)) }),
  );

  r.post(
    '/roles',
    {
      config: access.permission('roles:manage'),
      schema: {
        tags: ['roles'],
        body: z.object({ name: z.string().trim().min(2).max(60), permissions: permissionList }),
        response: { 201: z.object({ id: z.uuid() }) },
      },
    },
    async (req, reply) => reply.status(201).send(await createRole(ctx, actorOf(req), req.body)),
  );

  r.patch(
    '/roles/:id',
    {
      config: access.permission('roles:manage'),
      schema: {
        tags: ['roles'],
        params: idParam,
        body: z.object({
          name: z.string().trim().min(2).max(60).optional(),
          permissions: permissionList.optional(),
        }),
        response: { 200: ok },
      },
    },
    async (req) => {
      await updateRole(ctx, actorOf(req), req.params.id, {
        ...(req.body.name !== undefined ? { name: req.body.name } : {}),
        ...(req.body.permissions !== undefined ? { permissions: req.body.permissions } : {}),
      });
      return { ok: true as const };
    },
  );

  r.delete(
    '/roles/:id',
    {
      config: access.permission('roles:manage'),
      schema: { tags: ['roles'], params: idParam, response: { 200: ok } },
    },
    async (req) => {
      await deleteRole(ctx, actorOf(req), req.params.id);
      return { ok: true as const };
    },
  );

  // ---- auditoria
  r.get(
    '/audit-logs',
    {
      config: access.permission('audit:read'),
      schema: {
        tags: ['audit'],
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.uuid().optional(),
          action: z.string().max(80).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.uuid(),
                actorUserId: z.string().nullable(),
                action: z.string(),
                targetType: z.string().nullable(),
                targetId: z.string().nullable(),
                metadata: z.unknown(),
                ip: z.string().nullable(),
                createdAt: z.date(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    (req) =>
      listAuditLogs(ctx, actorOf(req), {
        limit: req.query.limit,
        ...(req.query.before ? { before: req.query.before } : {}),
        ...(req.query.action ? { action: req.query.action } : {}),
      }),
  );
}
