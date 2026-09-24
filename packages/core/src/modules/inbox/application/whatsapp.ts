import { schema, withInboxPublicKey, withTenant } from '@waychat/db';
import { uuidv7 } from '@waychat/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../../context.js';
import { randomToken } from '../../../crypto/tokens.js';
import { uniqueViolation } from '../../../db-errors.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';
import { enqueueEvent } from '../../events/application/enqueue.js';
import { toInboxView, type InboxView } from './inboxes.js';

const { inboxes, inboxMembers } = schema;

/** Palavras que pedem para parar de receber mensagens (comparadas sem acento nem caixa, texto inteiro). */
export const DEFAULT_OPT_OUT_KEYWORDS = ['SAIR', 'PARAR'];
export const DEFAULT_OPT_OUT_REPLY =
  'Tudo bem, você não receberá mais mensagens. Para voltar a receber, é só nos escrever.';
export const DEFAULT_RATE_LIMIT_PER_SECOND = 80;

/** Configuração do canal, guardada CIFRADA (AES-256-GCM, AAD `inbox:<id>`). Nada aqui vai para log. */
const whatsappConfigSchema = z.object({
  phoneNumberId: z.string(),
  wabaId: z.string(),
  /** Token do System User. */
  accessToken: z.string(),
  appSecret: z.string(),
  /** Gerado no servidor; o admin cola na tela de webhook da Meta. */
  verifyToken: z.string(),
  optOutKeywords: z.array(z.string()).default(DEFAULT_OPT_OUT_KEYWORDS),
  /** `null` = não responder ao opt-out. */
  optOutReply: z.string().nullable().default(DEFAULT_OPT_OUT_REPLY),
  sendReadReceipts: z.boolean().default(true),
  sendTypingIndicator: z.boolean().default(true),
  /** Mensagens por segundo enviadas por este número (a Meta permite até 80 por padrão). */
  rateLimitPerSecond: z.number().int().min(1).max(1000).default(DEFAULT_RATE_LIMIT_PER_SECOND),
});
export type WhatsAppConfig = z.infer<typeof whatsappConfigSchema>;

const digits = z.string().regex(/^\d{5,25}$/, 'somente dígitos');
const secret = (min: number) => z.string().trim().min(min).max(600);
const settings = {
  optOutKeywords: z.array(z.string().trim().min(2).max(30)).min(1).max(20).optional(),
  optOutReply: z.string().trim().max(500).nullable().optional(),
  sendReadReceipts: z.boolean().optional(),
  sendTypingIndicator: z.boolean().optional(),
  rateLimitPerSecond: z.number().int().min(1).max(1000).optional(),
};

export const connectWhatsAppInput = z.object({
  name: z.string().trim().min(2).max(80),
  phoneNumberId: digits,
  wabaId: digits,
  accessToken: secret(20),
  appSecret: secret(16),
  ...settings,
});

export const updateWhatsAppInput = z.object({
  phoneNumberId: digits.optional(),
  wabaId: digits.optional(),
  /** Rotação: informar o novo valor substitui o antigo (o antigo deixa de valer na hora). */
  accessToken: secret(20).optional(),
  appSecret: secret(16).optional(),
  rotateVerifyToken: z.boolean().optional(),
  ...settings,
});

const last4 = (s: string) => (s.length <= 4 ? '••••' : `••••${s.slice(-4)}`);
const aad = (inboxId: string) => `inbox:${inboxId}`;

/** O que a tela mostra: segredos sempre mascarados (só os 4 últimos caracteres). O verify token não é segredo de longo prazo. */
export interface WhatsAppConnectionView {
  inboxId: string;
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  /** Caminho a configurar no painel da Meta (a base pública é o `PUBLIC_URL`). */
  webhookPath: string;
  optOutKeywords: string[];
  optOutReply: string | null;
  sendReadReceipts: boolean;
  sendTypingIndicator: boolean;
  rateLimitPerSecond: number;
  qualityRating: string | null;
  messagingTier: string | null;
}

export function readWhatsAppConfig(
  ctx: Ctx,
  row: { id: string; channelType: string; configEncrypted: string | null },
): WhatsAppConfig | null {
  if (row.channelType !== 'whatsapp' || !row.configEncrypted) return null;
  return whatsappConfigSchema.parse(
    JSON.parse(ctx.keyring.decrypt(row.configEncrypted, aad(row.id))),
  );
}

const toConnection = (
  cfg: WhatsAppConfig,
  row: {
    id: string;
    publicKey: string;
    qualityRating: string | null;
    messagingTier: string | null;
  },
): WhatsAppConnectionView => ({
  inboxId: row.id,
  phoneNumberId: cfg.phoneNumberId,
  wabaId: cfg.wabaId,
  accessToken: last4(cfg.accessToken),
  appSecret: last4(cfg.appSecret),
  verifyToken: cfg.verifyToken,
  webhookPath: `/webhooks/whatsapp/${row.publicKey}`,
  optOutKeywords: cfg.optOutKeywords,
  optOutReply: cfg.optOutReply,
  sendReadReceipts: cfg.sendReadReceipts,
  sendTypingIndicator: cfg.sendTypingIndicator,
  rateLimitPerSecond: cfg.rateLimitPerSecond,
  qualityRating: row.qualityRating,
  messagingTier: row.messagingTier,
});

const normalizeKeywords = (list: string[]) => [...new Set(list.map((k) => k.trim().toUpperCase()))];

function parseInput<T>(schemaObj: z.ZodType<T>, input: unknown): T {
  const r = schemaObj.safeParse(input);
  if (!r.success)
    throw new DomainError('invalid_input', r.error.issues.map((i) => i.path.join('.')).join(', '));
  return r.data;
}

/** Conecta um número do WhatsApp Cloud API a uma nova inbox. Quem conecta entra como membro. */
export async function connectWhatsApp(
  ctx: Ctx,
  actor: Actor,
  rawInput: unknown,
): Promise<{ inbox: InboxView; connection: WhatsAppConnectionView }> {
  assertCan(actor, 'inboxes:manage');
  const input = parseInput(connectWhatsAppInput, rawInput);
  const id = uuidv7();
  const config: WhatsAppConfig = whatsappConfigSchema.parse({
    phoneNumberId: input.phoneNumberId,
    wabaId: input.wabaId,
    accessToken: input.accessToken,
    appSecret: input.appSecret,
    verifyToken: randomToken(24),
    ...(input.optOutKeywords ? { optOutKeywords: normalizeKeywords(input.optOutKeywords) } : {}),
    ...(input.optOutReply !== undefined ? { optOutReply: input.optOutReply } : {}),
    ...(input.sendReadReceipts !== undefined ? { sendReadReceipts: input.sendReadReceipts } : {}),
    ...(input.sendTypingIndicator !== undefined
      ? { sendTypingIndicator: input.sendTypingIndicator }
      : {}),
    ...(input.rateLimitPerSecond !== undefined
      ? { rateLimitPerSecond: input.rateLimitPerSecond }
      : {}),
  });
  try {
    const row = await withTenant(ctx.db, actor.accountId, async (tx) => {
      const [created] = await tx
        .insert(inboxes)
        .values({
          id,
          accountId: actor.accountId,
          name: input.name,
          channelType: 'whatsapp',
          publicKey: `ibx_${randomToken(12)}`,
          configEncrypted: ctx.keyring.encrypt(JSON.stringify(config), aad(id)),
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
        // só identificadores públicos da Meta: nenhum segredo
        metadata: { channel_type: 'whatsapp', phone_number_id: config.phoneNumberId },
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
    return { inbox: toInboxView(ctx, row), connection: toConnection(config, row) };
  } catch (e) {
    if (uniqueViolation(e)) throw new DomainError('name_taken');
    throw e;
  }
}

async function loadOwn(ctx: Ctx, actor: Actor, inboxId: string) {
  const row = await withTenant(ctx.db, actor.accountId, async (tx) => {
    const [r] = await tx.select().from(inboxes).where(eq(inboxes.id, inboxId)).limit(1);
    return r;
  });
  const cfg = row ? readWhatsAppConfig(ctx, row) : null;
  if (!row || !cfg) throw new DomainError('not_found');
  return { row, cfg };
}

export async function getWhatsAppConnection(
  ctx: Ctx,
  actor: Actor,
  inboxId: string,
): Promise<WhatsAppConnectionView> {
  assertCan(actor, 'inboxes:manage');
  const { row, cfg } = await loadOwn(ctx, actor, inboxId);
  return toConnection(cfg, row);
}

export async function updateWhatsAppConnection(
  ctx: Ctx,
  actor: Actor,
  inboxId: string,
  rawInput: unknown,
): Promise<WhatsAppConnectionView> {
  assertCan(actor, 'inboxes:manage');
  const input = parseInput(updateWhatsAppInput, rawInput);
  const { row: current, cfg } = await loadOwn(ctx, actor, inboxId);
  const next: WhatsAppConfig = {
    ...cfg,
    ...(input.phoneNumberId ? { phoneNumberId: input.phoneNumberId } : {}),
    ...(input.wabaId ? { wabaId: input.wabaId } : {}),
    ...(input.accessToken ? { accessToken: input.accessToken } : {}),
    ...(input.appSecret ? { appSecret: input.appSecret } : {}),
    ...(input.rotateVerifyToken ? { verifyToken: randomToken(24) } : {}),
    ...(input.optOutKeywords ? { optOutKeywords: normalizeKeywords(input.optOutKeywords) } : {}),
    ...(input.optOutReply !== undefined ? { optOutReply: input.optOutReply } : {}),
    ...(input.sendReadReceipts !== undefined ? { sendReadReceipts: input.sendReadReceipts } : {}),
    ...(input.sendTypingIndicator !== undefined
      ? { sendTypingIndicator: input.sendTypingIndicator }
      : {}),
    ...(input.rateLimitPerSecond !== undefined
      ? { rateLimitPerSecond: input.rateLimitPerSecond }
      : {}),
  };
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    await tx
      .update(inboxes)
      .set({ configEncrypted: ctx.keyring.encrypt(JSON.stringify(next), aad(inboxId)) })
      .where(eq(inboxes.id, inboxId));
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'inbox.whatsapp_updated',
      targetType: 'inbox',
      targetId: inboxId,
      // só os NOMES dos campos trocados, nunca os valores
      metadata: { fields: Object.keys(input) },
    });
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'inbox',
      aggregateId: inboxId,
      type: 'inbox.updated',
      payload: { inbox_id: inboxId },
    });
  });
  return toConnection(next, current);
}

export interface WhatsAppTarget {
  accountId: string;
  inboxId: string;
  enabled: boolean;
  config: WhatsAppConfig;
}

/**
 * Localiza a inbox do webhook pela chave pública da URL (ainda sem tenant). Chave desconhecida, inbox de outro
 * canal ou sem configuração: `null` — o chamador responde igual nos três casos.
 */
export async function loadWhatsAppByPublicKey(
  ctx: Ctx,
  publicKey: string,
): Promise<WhatsAppTarget | null> {
  const row = await withInboxPublicKey(ctx.db, publicKey, async (tx) => {
    const [r] = await tx.select().from(inboxes).where(eq(inboxes.publicKey, publicKey)).limit(1);
    return r;
  });
  const config = row ? readWhatsAppConfig(ctx, row) : null;
  if (!row || !config) return null;
  return { accountId: row.accountId, inboxId: row.id, enabled: row.enabled, config };
}
