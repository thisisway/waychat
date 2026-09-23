import { randomBytes } from 'node:crypto';
import { schema, withApiKeyPrefix, withTenant } from '@waychat/db';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../../context.js';
import { randomToken, safeEqual, sha256Hex } from '../../../crypto/tokens.js';
import { uniqueViolation } from '../../../db-errors.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';

const { apiKeys } = schema;

/** Escopos das chaves de API. Cada rota do canal API exige um deles. */
export const API_SCOPES = ['messages:write', 'conversations:read', 'contacts:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

const KEY_PREFIX_LENGTH = 8;
/** `last_used_at` só é regravado se estiver mais velho que isto: evita um UPDATE por requisição. */
const LAST_USED_GRANULARITY_MS = 60_000;

export interface ApiKeyView {
  id: string;
  name: string;
  /** Prefixo de identificação (`wc_xxxxxxxx`), seguro para exibir; o segredo nunca é recuperável. */
  prefix: string;
  scopes: ApiScope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export const createApiKeyInput = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  expiresAt: z.coerce.date().optional(),
});

const toView = (r: typeof apiKeys.$inferSelect): ApiKeyView => ({
  id: r.id,
  name: r.name,
  prefix: `wc_${r.keyPrefix}`,
  scopes: r.scopes as ApiScope[],
  expiresAt: r.expiresAt,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
  createdAt: r.createdAt,
});

/**
 * Formato: `wc_<prefixo de 8 hex>_<segredo de 256 bits em base64url>`. O prefixo localiza a chave (é público);
 * só o SHA-256 do segredo é guardado, então nem o banco consegue reconstruir a chave. O texto completo é
 * devolvido UMA vez, na criação.
 */
export async function createApiKey(
  ctx: Ctx,
  actor: Actor,
  rawInput: unknown,
): Promise<{ key: string; apiKey: ApiKeyView }> {
  assertCan(actor, 'api_keys:manage');
  const parsed = createApiKeyInput.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('invalid_input');
  const input = parsed.data;
  if (input.expiresAt && input.expiresAt <= ctx.now())
    throw new DomainError('invalid_input', 'expiração no passado');

  for (let attempt = 0; attempt < 3; attempt++) {
    const prefix = randomBytes(KEY_PREFIX_LENGTH / 2).toString('hex');
    const secret = randomToken(32);
    try {
      const row = await withTenant(ctx.db, actor.accountId, async (tx) => {
        const [created] = await tx
          .insert(apiKeys)
          .values({
            accountId: actor.accountId,
            name: input.name,
            keyPrefix: prefix,
            keyHash: sha256Hex(secret),
            scopes: input.scopes,
            expiresAt: input.expiresAt ?? null,
            createdBy: actor.userId,
          })
          .returning();
        if (!created) throw new Error('falha ao criar chave');
        await recordAudit(tx, {
          accountId: actor.accountId,
          actorUserId: actor.userId,
          action: 'api_key.created',
          targetType: 'api_key',
          targetId: created.id,
          metadata: { scopes: input.scopes },
        });
        return created;
      });
      return { key: `wc_${prefix}_${secret}`, apiKey: toView(row) };
    } catch (e) {
      if (uniqueViolation(e)) continue; // colisão de prefixo (1 em 4 bilhões): tenta outro
      throw e;
    }
  }
  throw new Error('não foi possível gerar um prefixo único');
}

export async function listApiKeys(ctx: Ctx, actor: Actor): Promise<ApiKeyView[]> {
  assertCan(actor, 'api_keys:read');
  const rows = await withTenant(ctx.db, actor.accountId, (tx) =>
    tx.select().from(apiKeys).orderBy(apiKeys.createdAt),
  );
  return rows.map(toView);
}

export async function revokeApiKey(ctx: Ctx, actor: Actor, keyId: string): Promise<void> {
  assertCan(actor, 'api_keys:manage');
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    const done = await tx
      .update(apiKeys)
      .set({ revokedAt: ctx.now() })
      .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (done.length === 0) throw new DomainError('not_found');
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: keyId,
    });
  });
}

export interface ApiKeyPrincipal {
  accountId: string;
  keyId: string;
  scopes: ReadonlySet<ApiScope>;
}

/**
 * Autentica uma chave de API. Toda falha (formato, prefixo desconhecido, segredo errado, revogada, expirada)
 * devolve o mesmo `api_key_invalid`, e a comparação do hash é em tempo constante.
 */
export async function verifyApiKey(ctx: Ctx, presented: string): Promise<ApiKeyPrincipal> {
  const invalid = new DomainError('api_key_invalid');
  const m = /^wc_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/.exec(presented);
  const prefix = m?.[1];
  const secret = m?.[2];
  if (!prefix || !secret) throw invalid;

  const row = await withApiKeyPrefix(ctx.db, prefix, async (tx) => {
    const [r] = await tx.select().from(apiKeys).where(eq(apiKeys.keyPrefix, prefix)).limit(1);
    return r;
  });
  // compara sempre, mesmo sem linha, para não vazar por tempo se o prefixo existe
  const expected = row?.keyHash ?? sha256Hex('inexistente');
  const hashOk = safeEqual(sha256Hex(secret), expected);
  if (!row || !hashOk) throw invalid;

  const now = ctx.now();
  if (row.revokedAt || (row.expiresAt && row.expiresAt <= now)) throw invalid;

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS) {
    const threshold = new Date(now.getTime() - LAST_USED_GRANULARITY_MS);
    await withTenant(ctx.db, row.accountId, (tx) =>
      tx
        .update(apiKeys)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(apiKeys.id, row.id),
            or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, threshold)),
          ),
        ),
    );
  }
  return { accountId: row.accountId, keyId: row.id, scopes: new Set(row.scopes as ApiScope[]) };
}
