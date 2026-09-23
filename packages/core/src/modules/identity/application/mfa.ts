import { randomBytes } from 'node:crypto';
import { schema } from '@waychat/db';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { generateSecret, generateURI, verifySync } from 'otplib';
import type { Ctx } from '../../../context.js';
import { sha256Hex } from '../../../crypto/tokens.js';
import { DomainError } from '../../../errors.js';

const { userMfaFactors, userRecoveryCodes, users } = schema;

const aad = (userId: string) => `mfa:${userId}`;
const RECOVERY_CODE_COUNT = 10;
/** Tolerância de relógio do celular: ±30 s (um passo para cada lado). */
const EPOCH_TOLERANCE = 30;

function generateRecoveryCodes(): string[] {
  // 10 bytes = 80 bits por código; formato xxxxx-xxxxx em hex facilita a digitação.
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const h = randomBytes(5).toString('hex');
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
}

const normalizeRecovery = (code: string) => code.trim().toLowerCase();

export async function hasConfirmedTotp(ctx: Ctx, userId: string): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: userMfaFactors.id })
    .from(userMfaFactors)
    .where(and(eq(userMfaFactors.userId, userId), isNotNull(userMfaFactors.confirmedAt)))
    .limit(1);
  return rows.length > 0;
}

/** Inicia o cadastro do TOTP: devolve o segredo (para o QR code) e o URI otpauth. O fator só vale depois de confirmado. */
export async function beginTotpEnrollment(
  ctx: Ctx,
  userId: string,
): Promise<{ secret: string; otpauthUri: string }> {
  if (await hasConfirmedTotp(ctx, userId)) throw new DomainError('mfa_already_enrolled');
  const [user] = await ctx.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new DomainError('not_found');

  const secret = generateSecret();
  const secretEncrypted = ctx.keyring.encrypt(secret, aad(userId));
  await ctx.db
    .insert(userMfaFactors)
    .values({ userId, type: 'totp', secretEncrypted })
    .onConflictDoUpdate({
      target: [userMfaFactors.userId, userMfaFactors.type],
      set: { secretEncrypted, confirmedAt: null, lastUsedStep: null },
    });
  return {
    secret,
    otpauthUri: generateURI({ issuer: ctx.config.issuer, label: user.email, secret }),
  };
}

/** Confirma o cadastro com um código válido, ativa o fator e devolve os códigos de recuperação (mostrados uma única vez). */
export async function confirmTotpEnrollment(
  ctx: Ctx,
  userId: string,
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const [factor] = await ctx.db
    .select()
    .from(userMfaFactors)
    .where(
      and(
        eq(userMfaFactors.userId, userId),
        eq(userMfaFactors.type, 'totp'),
        isNull(userMfaFactors.confirmedAt),
      ),
    )
    .limit(1);
  if (!factor) throw new DomainError('mfa_not_enrolled');

  const secret = ctx.keyring.decrypt(factor.secretEncrypted, aad(userId));
  const result = verifySync({
    secret,
    token: code.trim(),
    epochTolerance: EPOCH_TOLERANCE,
    epoch: epochSeconds(ctx),
  });
  if (!result.valid) throw new DomainError('invalid_mfa_code');

  const recoveryCodes = generateRecoveryCodes();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(userMfaFactors)
      .set({ confirmedAt: ctx.now(), lastUsedStep: stepOf(result) })
      .where(eq(userMfaFactors.id, factor.id));
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await tx
      .insert(userRecoveryCodes)
      .values(recoveryCodes.map((c) => ({ userId, codeHash: sha256Hex(normalizeRecovery(c)) })));
  });
  return { recoveryCodes };
}

export type SecondFactor = { code: string } | { recoveryCode: string };

/** Passo de tempo (30 s) em que o código bateu: `epoch` é o início do período correspondente. */
function stepOf(result: object): number {
  if (!('epoch' in result) || typeof result.epoch !== 'number')
    throw new Error('resultado TOTP sem epoch');
  return Math.floor(result.epoch / 30);
}

const epochSeconds = (ctx: Ctx) => Math.floor(ctx.now().getTime() / 1000);

/**
 * Verifica o segundo fator. TOTP: o mesmo código nunca vale duas vezes (o passo de tempo só avança, com UPDATE condicional
 * que também fecha a corrida entre duas requisições simultâneas). Recuperação: uso único, também atômico.
 */
export async function verifySecondFactor(
  ctx: Ctx,
  userId: string,
  input: SecondFactor,
): Promise<boolean> {
  if ('recoveryCode' in input) {
    const used = await ctx.db
      .update(userRecoveryCodes)
      .set({ usedAt: ctx.now() })
      .where(
        and(
          eq(userRecoveryCodes.userId, userId),
          eq(userRecoveryCodes.codeHash, sha256Hex(normalizeRecovery(input.recoveryCode))),
          isNull(userRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: userRecoveryCodes.id });
    return used.length === 1;
  }

  const [factor] = await ctx.db
    .select()
    .from(userMfaFactors)
    .where(
      and(
        eq(userMfaFactors.userId, userId),
        eq(userMfaFactors.type, 'totp'),
        isNotNull(userMfaFactors.confirmedAt),
      ),
    )
    .limit(1);
  if (!factor) return false;

  const secret = ctx.keyring.decrypt(factor.secretEncrypted, aad(userId));
  const result = verifySync({
    secret,
    token: input.code.trim(),
    epochTolerance: EPOCH_TOLERANCE,
    epoch: epochSeconds(ctx),
  });
  if (!result.valid) return false;

  const advanced = await ctx.db
    .update(userMfaFactors)
    .set({ lastUsedStep: stepOf(result) })
    .where(
      and(
        eq(userMfaFactors.id, factor.id),
        or(isNull(userMfaFactors.lastUsedStep), lt(userMfaFactors.lastUsedStep, stepOf(result))),
      ),
    )
    .returning({ id: userMfaFactors.id });
  return advanced.length === 1;
}

export async function countUnusedRecoveryCodes(ctx: Ctx, userId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(userRecoveryCodes)
    .where(and(eq(userRecoveryCodes.userId, userId), isNull(userRecoveryCodes.usedAt)));
  return row?.n ?? 0;
}
