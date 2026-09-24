import { schema, withTenant } from '@waychat/db';
import { uuidv7 } from '@waychat/shared';
import { and, count, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../../context.js';
import { randomToken } from '../../../crypto/tokens.js';
import { uniqueViolation } from '../../../db-errors.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';
import { enqueueEvent } from '../../events/application/enqueue.js';

const { inboxes, inboxMembers, accountUsers, conversations, users } = schema;

export const CHANNEL_TYPES = ['api', 'widget', 'whatsapp'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** Configuração do canal, guardada CIFRADA (AES-256-GCM, AAD `inbox:<id>`). Nada aqui vai para log. */
const widgetConfigSchema = z.object({
  /** Segredo com que o site do cliente assina a identidade do visitante (HMAC). Gerado no servidor. */
  identitySecret: z.string(),
  welcomeMessage: z.string().max(500).optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  /** Origens que podem embutir o widget (CORS e frame-ancestors do widget). Vazio = nenhuma. */
  allowedOrigins: z.array(z.url()).max(20).default([]),
});
type WidgetConfig = z.infer<typeof widgetConfigSchema>;

export interface InboxView {
  id: string;
  name: string;
  channelType: ChannelType;
  /** Identificador público: vai no snippet do widget e na URL do canal API. Não é segredo. */
  publicKey: string;
  enabled: boolean;
  welcomeMessage: string | null;
  primaryColor: string | null;
  allowedOrigins: string[];
}

const aad = (inboxId: string) => `inbox:${inboxId}`;
const newIdentitySecret = () => randomToken(32);
const newPublicKey = () => `ibx_${randomToken(12)}`;

export function readConfig(
  ctx: Ctx,
  row: { id: string; channelType: string; configEncrypted: string | null },
) {
  if (row.channelType !== 'widget' || !row.configEncrypted) return null;
  return widgetConfigSchema.parse(
    JSON.parse(ctx.keyring.decrypt(row.configEncrypted, aad(row.id))),
  );
}

export function toInboxView(
  ctx: Ctx,
  row: {
    id: string;
    name: string;
    channelType: string;
    publicKey: string;
    enabled: boolean;
    configEncrypted: string | null;
  },
): InboxView {
  const cfg = readConfig(ctx, row);
  return {
    id: row.id,
    name: row.name,
    channelType: row.channelType as ChannelType,
    publicKey: row.publicKey,
    enabled: row.enabled,
    welcomeMessage: cfg?.welcomeMessage ?? null,
    primaryColor: cfg?.primaryColor ?? null,
    allowedOrigins: cfg?.allowedOrigins ?? [],
  };
}

export const createInboxInput = z.object({
  name: z.string().trim().min(2).max(80),
  channelType: z.enum(CHANNEL_TYPES),
  welcomeMessage: z.string().max(500).optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  allowedOrigins: z.array(z.url()).max(20).optional(),
});

function parseInput<T>(schemaObj: z.ZodType<T>, input: unknown): T {
  const r = schemaObj.safeParse(input);
  if (!r.success)
    throw new DomainError('invalid_input', r.error.issues.map((i) => i.path.join('.')).join(', '));
  return r.data;
}

/**
 * Cria a inbox. Para widget devolve o `identitySecret` UMA vez (depois só existe cifrado).
 * Quem cria entra como membro, para enxergar as conversas da própria inbox.
 */
export async function createInbox(
  ctx: Ctx,
  actor: Actor,
  rawInput: unknown,
): Promise<{ inbox: InboxView; identitySecret: string | null }> {
  assertCan(actor, 'inboxes:manage');
  const input = parseInput(createInboxInput, rawInput);
  // o WhatsApp exige credenciais da Meta: tem rota própria (`connectWhatsApp`)
  if (input.channelType === 'whatsapp')
    throw new DomainError('invalid_input', 'use a conexão do WhatsApp para criar esta caixa');
  const id = uuidv7();
  const identitySecret = input.channelType === 'widget' ? newIdentitySecret() : null;
  const config: WidgetConfig | null =
    input.channelType === 'widget' && identitySecret
      ? {
          identitySecret,
          ...(input.welcomeMessage ? { welcomeMessage: input.welcomeMessage } : {}),
          ...(input.primaryColor ? { primaryColor: input.primaryColor } : {}),
          allowedOrigins: input.allowedOrigins ?? [],
        }
      : null;
  try {
    const row = await withTenant(ctx.db, actor.accountId, async (tx) => {
      const [created] = await tx
        .insert(inboxes)
        .values({
          id,
          accountId: actor.accountId,
          name: input.name,
          channelType: input.channelType,
          publicKey: newPublicKey(),
          configEncrypted: config ? ctx.keyring.encrypt(JSON.stringify(config), aad(id)) : null,
        })
        .returning();
      if (!created) throw new Error('falha ao criar inbox');
      await tx
        .insert(inboxMembers)
        .values({ accountId: actor.accountId, inboxId: id, userId: actor.userId });
      await recordAudit(tx, {
        accountId: actor.accountId,
        actorUserId: actor.userId,
        action: 'inbox.created',
        targetType: 'inbox',
        targetId: id,
        metadata: { channel_type: input.channelType },
      });
      await enqueueEvent(tx, {
        accountId: actor.accountId,
        aggregateType: 'inbox',
        aggregateId: id,
        type: 'inbox.created',
        payload: { inbox_id: id },
      });
      return created;
    });
    return { inbox: toInboxView(ctx, row), identitySecret };
  } catch (e) {
    if (uniqueViolation(e)) throw new DomainError('name_taken');
    throw e;
  }
}

/** Quem tem `inboxes:read` vê todas; os demais veem só as inboxes de que são membros. */
export async function listInboxes(ctx: Ctx, actor: Actor): Promise<InboxView[]> {
  const seeAll = actor.permissions.has('inboxes:read');
  const rows = await withTenant(ctx.db, actor.accountId, async (tx) => {
    if (seeAll) return tx.select().from(inboxes).orderBy(inboxes.createdAt);
    return tx
      .select({
        id: inboxes.id,
        accountId: inboxes.accountId,
        name: inboxes.name,
        channelType: inboxes.channelType,
        publicKey: inboxes.publicKey,
        configEncrypted: inboxes.configEncrypted,
        enabled: inboxes.enabled,
        createdAt: inboxes.createdAt,
        updatedAt: inboxes.updatedAt,
      })
      .from(inboxes)
      .innerJoin(inboxMembers, eq(inboxMembers.inboxId, inboxes.id))
      .where(eq(inboxMembers.userId, actor.userId))
      .orderBy(inboxes.createdAt);
  });
  return rows.map((r) => toInboxView(ctx, r));
}

/** Ids das inboxes que o usuário enxerga (base do filtro de visibilidade das conversas). */
export async function visibleInboxIds(ctx: Ctx, actor: Actor): Promise<string[]> {
  return (await listInboxes(ctx, actor)).map((i) => i.id);
}

export const updateInboxInput = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  enabled: z.boolean().optional(),
  welcomeMessage: z.string().max(500).nullable().optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  allowedOrigins: z.array(z.url()).max(20).optional(),
});

export async function updateInbox(
  ctx: Ctx,
  actor: Actor,
  inboxId: string,
  rawInput: unknown,
): Promise<InboxView> {
  assertCan(actor, 'inboxes:manage');
  const input = parseInput(updateInboxInput, rawInput);
  try {
    const row = await withTenant(ctx.db, actor.accountId, async (tx) => {
      const [current] = await tx.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
      if (!current) throw new DomainError('not_found');
      const cfg = readConfig(ctx, current);
      let configEncrypted = current.configEncrypted;
      if (cfg) {
        const next: WidgetConfig = { ...cfg };
        if (input.welcomeMessage !== undefined) {
          if (input.welcomeMessage === null) delete next.welcomeMessage;
          else next.welcomeMessage = input.welcomeMessage;
        }
        if (input.primaryColor !== undefined) {
          if (input.primaryColor === null) delete next.primaryColor;
          else next.primaryColor = input.primaryColor;
        }
        if (input.allowedOrigins !== undefined) next.allowedOrigins = input.allowedOrigins;
        configEncrypted = ctx.keyring.encrypt(JSON.stringify(next), aad(inboxId));
      }
      const [updated] = await tx
        .update(inboxes)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          configEncrypted,
        })
        .where(eq(inboxes.id, inboxId))
        .returning();
      if (!updated) throw new DomainError('not_found');
      await recordAudit(tx, {
        accountId: actor.accountId,
        actorUserId: actor.userId,
        action: 'inbox.updated',
        targetType: 'inbox',
        targetId: inboxId,
        metadata: { fields: Object.keys(input) },
      });
      await enqueueEvent(tx, {
        accountId: actor.accountId,
        aggregateType: 'inbox',
        aggregateId: inboxId,
        type: 'inbox.updated',
        payload: { inbox_id: inboxId },
      });
      return updated;
    });
    return toInboxView(ctx, row);
  } catch (e) {
    if (uniqueViolation(e)) throw new DomainError('name_taken');
    throw e;
  }
}

/** Gera um novo segredo de identidade (o antigo deixa de valer na hora) e o devolve uma única vez. */
export async function rotateIdentitySecret(
  ctx: Ctx,
  actor: Actor,
  inboxId: string,
): Promise<{ identitySecret: string }> {
  assertCan(actor, 'inboxes:manage');
  const identitySecret = newIdentitySecret();
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    const [current] = await tx.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    if (!current) throw new DomainError('not_found');
    const cfg = readConfig(ctx, current);
    if (!cfg) throw new DomainError('invalid_input', 'a inbox não usa segredo de identidade');
    await tx
      .update(inboxes)
      .set({
        configEncrypted: ctx.keyring.encrypt(
          JSON.stringify({ ...cfg, identitySecret }),
          aad(inboxId),
        ),
      })
      .where(eq(inboxes.id, inboxId));
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'inbox.identity_secret_rotated',
      targetType: 'inbox',
      targetId: inboxId,
    });
  });
  return { identitySecret };
}

/** Só sem conversas: apagar uma inbox levaria o histórico junto. Com histórico, desative (`enabled: false`). */
export async function deleteInbox(ctx: Ctx, actor: Actor, inboxId: string): Promise<void> {
  assertCan(actor, 'inboxes:manage');
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    const [row] = await tx
      .select({ id: inboxes.id })
      .from(inboxes)
      .where(eq(inboxes.id, inboxId))
      .limit(1);
    if (!row) throw new DomainError('not_found');
    const [used] = await tx
      .select({ n: count() })
      .from(conversations)
      .where(eq(conversations.inboxId, inboxId));
    if ((used?.n ?? 0) > 0) throw new DomainError('inbox_in_use');
    await tx.delete(inboxes).where(eq(inboxes.id, inboxId));
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'inbox.deleted',
      targetType: 'inbox',
      targetId: inboxId,
    });
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'inbox',
      aggregateId: inboxId,
      type: 'inbox.deleted',
      payload: { inbox_id: inboxId },
    });
  });
}

export interface InboxMemberView {
  userId: string;
  name: string;
  email: string;
}

export async function listInboxMembers(
  ctx: Ctx,
  actor: Actor,
  inboxId: string,
): Promise<InboxMemberView[]> {
  assertCan(actor, 'inboxes:read');
  return withTenant(ctx.db, actor.accountId, (tx) =>
    tx
      .select({ userId: users.id, name: users.name, email: users.email })
      .from(inboxMembers)
      .innerJoin(users, eq(users.id, inboxMembers.userId))
      .where(eq(inboxMembers.inboxId, inboxId))
      .orderBy(users.name),
  );
}

/** Substitui a lista de membros. Só aceita gente que já pertence à conta. */
export async function setInboxMembers(
  ctx: Ctx,
  actor: Actor,
  inboxId: string,
  userIds: string[],
): Promise<void> {
  assertCan(actor, 'inboxes:manage');
  const unique = [...new Set(userIds)];
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    const [inbox] = await tx
      .select({ id: inboxes.id })
      .from(inboxes)
      .where(eq(inboxes.id, inboxId))
      .limit(1);
    if (!inbox) throw new DomainError('not_found');
    if (unique.length > 0) {
      const members = await tx
        .select({ userId: accountUsers.userId })
        .from(accountUsers)
        .where(
          and(eq(accountUsers.accountId, actor.accountId), inArray(accountUsers.userId, unique)),
        );
      if (members.length !== unique.length) throw new DomainError('not_a_member');
    }
    await tx.delete(inboxMembers).where(eq(inboxMembers.inboxId, inboxId));
    if (unique.length > 0) {
      await tx
        .insert(inboxMembers)
        .values(unique.map((userId) => ({ accountId: actor.accountId, inboxId, userId })));
    }
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'inbox.members_changed',
      targetType: 'inbox',
      targetId: inboxId,
      metadata: { count: unique.length },
    });
    // Quem entra ou sai de uma inbox passa a enxergar (ou deixa de enxergar) as conversas dela: o gateway em tempo
    // real recalcula a visibilidade dos usuários conectados ao receber este evento.
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'inbox',
      aggregateId: inboxId,
      type: 'inbox.updated',
      payload: { inbox_id: inboxId },
    });
  });
}
