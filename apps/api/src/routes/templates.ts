import {
  createTemplate as createMetaTemplate,
  listTemplates as listMetaTemplates,
  normalizeTemplateStatus,
  type GraphConfig,
  type RemoteTemplateComponent,
} from '@waychat/channels-whatsapp';
import {
  DomainError,
  listWhatsAppTemplates,
  loadWhatsAppTarget,
  upsertTemplateFromMeta,
  type Ctx,
} from '@waychat/core';
import type { Env } from '@waychat/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { access } from '../types.js';
import { actorOf } from './auth.js';

const templateView = z.object({
  id: z.uuid(),
  providerTemplateId: z.string().nullable(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  components: z.array(z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const componentInput = z.object({
  type: z.enum(['HEADER', 'BODY', 'FOOTER', 'BUTTONS']),
  format: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT']).optional(),
  text: z.string().optional(),
  buttons: z
    .array(
      z.object({
        type: z.string(),
        text: z.string(),
        url: z.string().optional(),
        phone_number: z.string().optional(),
      }),
    )
    .optional(),
});

async function targetOrNotFound(ctx: Ctx, accountId: string, inboxId: string) {
  const target = await loadWhatsAppTarget(ctx, accountId, inboxId);
  if (!target) throw new DomainError('not_found');
  return target;
}

const graphConfigFor = (
  env: Env,
  accessToken: string,
  fetchOverride?: typeof fetch,
): GraphConfig => ({
  accessToken,
  version: env.WHATSAPP_GRAPH_VERSION,
  baseUrl: env.WHATSAPP_GRAPH_BASE_URL,
  ...(fetchOverride ? { fetch: fetchOverride } : {}),
});

/**
 * Templates do WhatsApp: sincronização com a Meta, criação e leitura (D8). A Graph API é chamada aqui, na
 * borda HTTP — o núcleo nunca fala com a Meta diretamente (só grava/lê o que já foi resolvido). `graphFetch` é
 * injetável para teste (mesmo padrão do `GraphEnv` do worker); padrão é o `fetch` global.
 */
export function templateRoutes(
  app: FastifyInstance,
  ctx: Ctx,
  env: Env,
  graphFetch?: typeof fetch,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/inboxes/:id/templates',
    {
      config: access.permission('inboxes:manage'),
      schema: {
        tags: ['whatsapp'],
        params: z.object({ id: z.uuid() }),
        response: { 200: z.object({ templates: z.array(templateView) }) },
      },
    },
    async (req) => ({
      templates: await listWhatsAppTemplates(ctx, actorOf(req), req.params.id),
    }),
  );

  r.post(
    '/inboxes/:id/templates/sync',
    {
      config: access.permission('inboxes:manage'),
      schema: {
        tags: ['whatsapp'],
        params: z.object({ id: z.uuid() }),
        response: { 200: z.object({ templates: z.array(templateView) }) },
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const target = await targetOrNotFound(ctx, actor.accountId, req.params.id);
      const remote = await listMetaTemplates(
        graphConfigFor(env, target.config.accessToken, graphFetch),
        target.config.wabaId,
      );
      for (const tpl of remote) {
        await upsertTemplateFromMeta(ctx, target.accountId, target.inboxId, {
          providerTemplateId: tpl.id,
          name: tpl.name,
          language: tpl.language,
          category: tpl.category,
          status: normalizeTemplateStatus(tpl.status),
          reason: tpl.rejected_reason ?? null,
          components: tpl.components,
        });
      }
      return { templates: await listWhatsAppTemplates(ctx, actor, req.params.id) };
    },
  );

  r.post(
    '/inboxes/:id/templates',
    {
      config: access.permission('inboxes:manage'),
      schema: {
        tags: ['whatsapp'],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          name: z.string().trim().min(1).max(512),
          language: z.string().trim().min(2).max(35),
          category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION']),
          components: z.array(componentInput).min(1),
        }),
        response: { 201: templateView },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const target = await targetOrNotFound(ctx, actor.accountId, req.params.id);
      const graph = graphConfigFor(env, target.config.accessToken, graphFetch);
      const created = await createMetaTemplate(graph, target.config.wabaId, {
        name: req.body.name,
        language: req.body.language,
        category: req.body.category,
        components: req.body.components as RemoteTemplateComponent[],
      });
      const saved = await upsertTemplateFromMeta(ctx, target.accountId, target.inboxId, {
        providerTemplateId: created.id,
        name: req.body.name,
        language: req.body.language,
        category: created.category,
        status: normalizeTemplateStatus(created.status),
        components: req.body.components,
      });
      return reply.status(201).send(saved);
    },
  );
}
