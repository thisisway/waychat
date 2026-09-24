import { createHmac } from 'node:crypto';
import { schema, withInboxPublicKey, withTenant } from '@waychat/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Ctx } from '../../../context.js';
import { deriveKey, randomToken, safeEqual } from '../../../crypto/tokens.js';
import { DomainError } from '../../../errors.js';
import {
  attachmentsByMessage,
  type AttachmentView,
} from '../../attachments/application/attachments.js';
import { receiveInboundMessage } from '../../conversations/application/messages.js';
import { readConfig } from '../../inbox/application/inboxes.js';

const { inboxes, contactIdentities, conversations, messages } = schema;

const VISITOR_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const CHANNEL = 'widget';

/** Quem está falando pelo widget. Vem sempre do token assinado, nunca do corpo da requisição. */
export interface Visitor {
  accountId: string;
  inboxId: string;
  /** Identidade no contato: `user:<id do site>` (verificada por HMAC) ou `anon:<visitor_id>`. */
  externalId: string;
  name: string;
  email: string | null;
  /** Quando o token vence (só preenchido ao verificar um token). */
  expiresAt?: Date;
}

/** O que o visitante enxerga de uma mensagem: sem ids internos de atendente e sem notas privadas. */
export interface VisitorMessage {
  id: string;
  from: 'visitor' | 'agent';
  content: string;
  createdAt: Date;
  clientMessageId: string | null;
  attachments: AttachmentView[];
}

const visitorKey = (ctx: Ctx) => deriveKey(ctx.config.sessionSecret, 'widget-visitor');
const claims = z.object({
  sub: z.string().min(1).max(300),
  acc: z.uuid(),
  inb: z.uuid(),
  nm: z.string().max(200),
  em: z.string().max(320).nullable(),
});

async function signVisitor(ctx: Ctx, v: Visitor): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(ctx.now().getTime() / 1000);
  const exp = iat + VISITOR_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ acc: v.accountId, inb: v.inboxId, nm: v.name, em: v.email })
    .setProtectedHeader({ alg: 'HS256', typ: 'wv+jwt' })
    .setSubject(v.externalId)
    .setIssuer('waychat')
    .setAudience('waychat:widget-visitor')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(visitorKey(ctx));
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyVisitorToken(ctx: Ctx, token: string): Promise<Visitor> {
  try {
    const { payload } = await jwtVerify(token, visitorKey(ctx), {
      issuer: 'waychat',
      audience: 'waychat:widget-visitor',
      algorithms: ['HS256'],
      currentDate: ctx.now(),
    });
    const c = claims.parse(payload);
    return {
      accountId: c.acc,
      inboxId: c.inb,
      externalId: c.sub,
      name: c.nm,
      email: c.em,
      ...(payload.exp ? { expiresAt: new Date(payload.exp * 1000) } : {}),
    };
  } catch {
    throw new DomainError('invalid_token');
  }
}

const normalizeOrigin = (o: string) => {
  try {
    return new URL(o).origin;
  } catch {
    return null;
  }
};

const originInList = (list: readonly string[], origin: string | undefined): boolean => {
  const o = origin ? normalizeOrigin(origin) : null;
  return o !== null && list.some((a) => normalizeOrigin(a) === o);
};

/** Localiza a inbox do widget pela chave pública (ainda sem tenant) e devolve sua configuração decifrada. */
async function loadWidgetInbox(ctx: Ctx, publicKey: string) {
  const row = await withInboxPublicKey(ctx.db, publicKey, async (tx) => {
    const [r] = await tx.select().from(inboxes).where(eq(inboxes.publicKey, publicKey)).limit(1);
    return r;
  });
  // chave desconhecida, inbox de outro canal ou desativada: a mesma resposta
  if (!row || row.channelType !== CHANNEL || !row.enabled) throw new DomainError('not_found');
  const cfg = readConfig(ctx, row);
  if (!cfg) throw new DomainError('not_found');
  return { row, cfg };
}

/** A origem pode embutir o widget desta inbox? (lista vazia = nenhuma; inbox desativada = não) */
export async function widgetOriginAllowed(
  ctx: Ctx,
  v: Pick<Visitor, 'accountId' | 'inboxId'>,
  origin: string | undefined,
): Promise<boolean> {
  const row = await withTenant(ctx.db, v.accountId, async (tx) => {
    const [r] = await tx.select().from(inboxes).where(eq(inboxes.id, v.inboxId)).limit(1);
    return r;
  });
  if (!row || row.channelType !== CHANNEL || !row.enabled) return false;
  return originInList(readConfig(ctx, row)?.allowedOrigins ?? [], origin);
}

export const openSessionInput = z.object({
  public_key: z.string().min(1).max(100),
  /** Visitante anônimo que já esteve aqui: o id devolvido na primeira sessão. */
  visitor_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,64}$/)
    .optional(),
  /** Usuário logado no site do cliente. `hmac` = HMAC-SHA256(segredo de identidade, `user_id`) em hex. */
  identity: z
    .object({
      user_id: z.string().trim().min(1).max(200),
      hmac: z.string().regex(/^[0-9a-fA-F]{64}$/),
    })
    .optional(),
  /** Dados do pré-chat (nome/e-mail informados pelo visitante). */
  name: z.string().trim().min(1).max(200).optional(),
  email: z.email().max(320).optional(),
});

export interface WidgetSession {
  token: string;
  expiresAt: Date;
  /** Só para anônimo: o cliente guarda e reenvia para retomar a mesma conversa. */
  visitorId: string | null;
  identified: boolean;
  inbox: { name: string; welcomeMessage: string | null; primaryColor: string | null };
}

export async function openWidgetSession(
  ctx: Ctx,
  origin: string | undefined,
  rawInput: unknown,
): Promise<WidgetSession> {
  const parsed = openSessionInput.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('invalid_input');
  const input = parsed.data;
  const { row, cfg } = await loadWidgetInbox(ctx, input.public_key);

  if (!originInList(cfg.allowedOrigins, origin))
    throw new DomainError('forbidden', 'origem não permitida');

  let externalId: string;
  let visitorId: string | null = null;
  if (input.identity) {
    const expected = createHmac('sha256', cfg.identitySecret)
      .update(input.identity.user_id)
      .digest('hex');
    if (!safeEqual(expected, input.identity.hmac.toLowerCase()))
      throw new DomainError('forbidden', 'identidade inválida');
    externalId = `user:${input.identity.user_id}`;
  } else {
    visitorId = input.visitor_id ?? randomToken(16);
    externalId = `anon:${visitorId}`;
  }

  const visitor: Visitor = {
    accountId: row.accountId,
    inboxId: row.id,
    externalId,
    name: input.name ?? (input.identity ? input.identity.user_id : 'Visitante'),
    email: input.email ?? null,
  };
  const { token, expiresAt } = await signVisitor(ctx, visitor);
  return {
    token,
    expiresAt,
    visitorId,
    identified: Boolean(input.identity),
    inbox: {
      name: row.name,
      welcomeMessage: cfg.welcomeMessage ?? null,
      primaryColor: cfg.primaryColor ?? null,
    },
  };
}

const toVisitorMessage = (
  m: typeof messages.$inferSelect,
  attachments: AttachmentView[] = [],
): VisitorMessage => ({
  id: m.id,
  from: m.direction === 'in' ? 'visitor' : 'agent',
  content: m.content ?? '',
  createdAt: m.createdAt,
  clientMessageId: m.clientMessageId,
  attachments,
});

export const visitorSendInput = z.object({
  // com anexo o texto é opcional; a regra "nem texto nem anexo" fica em receiveInboundMessage
  content: z.string().trim().max(10_000).default(''),
  client_message_id: z.uuid().optional(),
  attachment_ids: z.array(z.uuid()).max(5).default([]),
});

export async function visitorSend(
  ctx: Ctx,
  v: Visitor,
  rawInput: unknown,
): Promise<{ message: VisitorMessage; duplicate: boolean }> {
  const parsed = visitorSendInput.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('invalid_input');
  const res = await receiveInboundMessage(ctx, {
    accountId: v.accountId,
    inboxId: v.inboxId,
    channelType: 'widget',
    identity: { channel: CHANNEL, externalId: v.externalId, name: v.name, email: v.email },
    content: parsed.data.content,
    attachmentIds: parsed.data.attachment_ids,
    ...(parsed.data.client_message_id ? { clientMessageId: parsed.data.client_message_id } : {}),
  });
  return {
    message: {
      id: res.message.id,
      from: 'visitor',
      content: res.message.content ?? '',
      createdAt: res.message.createdAt,
      clientMessageId: res.message.clientMessageId,
      attachments: res.message.attachments,
    },
    duplicate: res.duplicate,
  };
}

/** Histórico da conversa mais recente deste visitante nesta inbox (mais antigas primeiro), sem notas privadas. */
export async function visitorMessages(ctx: Ctx, v: Visitor, limit = 50): Promise<VisitorMessage[]> {
  return withTenant(ctx.db, v.accountId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(contactIdentities, eq(contactIdentities.contactId, conversations.contactId))
      .where(
        and(
          eq(conversations.inboxId, v.inboxId),
          eq(contactIdentities.channel, CHANNEL),
          eq(contactIdentities.externalId, v.externalId),
        ),
      )
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(1);
    if (!conv) return [];
    const rows = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.private, false)))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(Math.min(limit, 200));
    const atts = await attachmentsByMessage(
      tx,
      rows.map((m) => m.id),
    );
    return rows.reverse().map((m) => toVisitorMessage(m, atts.get(m.id) ?? []));
  });
}

/**
 * Para um evento `message.created`: se for resposta (saída, não privada) numa inbox de widget, devolve a quem
 * entregar (`inboxId` + `externalId`) e a mensagem já no formato do visitante. Qualquer outro caso: `null`.
 */
export async function loadVisitorDelivery(
  ctx: Ctx,
  accountId: string,
  messageId: string,
): Promise<{ inboxId: string; externalId: string; message: VisitorMessage } | null> {
  return withTenant(ctx.db, accountId, async (tx) => {
    const [row] = await tx
      .select({ m: messages, externalId: contactIdentities.externalId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .innerJoin(inboxes, eq(inboxes.id, conversations.inboxId))
      .innerJoin(contactIdentities, eq(contactIdentities.contactId, conversations.contactId))
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.direction, 'out'),
          eq(messages.private, false),
          eq(inboxes.channelType, CHANNEL),
          eq(contactIdentities.channel, CHANNEL),
        ),
      )
      .orderBy(asc(contactIdentities.createdAt))
      .limit(1);
    if (!row) return null;
    const atts = await attachmentsByMessage(tx, [row.m.id]);
    return {
      inboxId: row.m.inboxId,
      externalId: row.externalId,
      message: toVisitorMessage(row.m, atts.get(row.m.id) ?? []),
    };
  });
}
