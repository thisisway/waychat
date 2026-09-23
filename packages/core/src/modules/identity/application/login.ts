import { schema, withTenant, withUser } from '@waychat/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { sha256Hex } from '../../../crypto/tokens.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';
import { normalizeEmail } from '../domain/password-policy.js';
import { signChallenge, verifyChallenge } from '../infra/jwt.js';
import { verifyPassword } from '../infra/password.js';
import {
  confirmTotpEnrollment,
  hasConfirmedTotp,
  verifySecondFactor,
  type SecondFactor,
} from './mfa.js';
import { clientMeta, startSession, type ClientMeta, type TokenPair } from './sessions.js';

const { users, accountUsers, accounts } = schema;

/** Bloqueio progressivo: a partir da 5ª falha seguida, 30 s dobrando a cada falha, até 15 min. */
export const LOCK_AFTER_FAILURES = 5;
const LOCK_BASE_SECONDS = 30;
const LOCK_MAX_SECONDS = 15 * 60;

export function lockSeconds(failures: number): number {
  if (failures < LOCK_AFTER_FAILURES) return 0;
  return Math.min(LOCK_MAX_SECONDS, LOCK_BASE_SECONDS * 2 ** (failures - LOCK_AFTER_FAILURES));
}

export type LoginResult =
  | { status: 'authenticated'; accountId: string; tokens: TokenPair }
  | { status: 'mfa_required'; challenge: string }
  | { status: 'mfa_enrollment_required'; challenge: string };

export interface LoginInput extends ClientMeta {
  email: string;
  password: string;
  /** Conta desejada, se o usuário pertencer a várias. Padrão: a mais antiga. */
  accountId?: string;
}

const emailHash = (email: string) => sha256Hex(email).slice(0, 16);

async function registerFailure(
  ctx: Ctx,
  userId: string,
  meta: ClientMeta,
  action: string,
): Promise<void> {
  const [row] = await ctx.db
    .update(users)
    .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
    .where(eq(users.id, userId))
    .returning({ failed: users.failedLoginCount });
  const failed = row?.failed ?? 0;
  const seconds = lockSeconds(failed);
  if (seconds > 0) {
    await ctx.db
      .update(users)
      .set({ lockedUntil: new Date(ctx.now().getTime() + seconds * 1000) })
      .where(eq(users.id, userId));
  }
  await recordAudit(ctx.db, {
    accountId: null,
    actorUserId: userId,
    action: seconds > 0 ? 'login.locked' : action,
    metadata: { failures: failed, lock_seconds: seconds },
    ...clientMeta(meta),
  });
}

/**
 * Primeiro passo do login (senha). Toda falha devolve o mesmo erro `invalid_credentials`
 * (e-mail inexistente, senha errada, conta bloqueada ou desativada), com tempo de resposta equivalente.
 */
export async function login(ctx: Ctx, input: LoginInput): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const [user] = await ctx.db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? null);
  const locked = !!user?.lockedUntil && user.lockedUntil > ctx.now();

  if (!user || user.disabledAt || locked) {
    await recordAudit(ctx.db, {
      accountId: null,
      actorUserId: user?.id ?? null,
      action: 'login.failed',
      metadata: {
        reason: !user ? 'unknown_user' : user.disabledAt ? 'disabled' : 'locked',
        email_hash: emailHash(email),
      },
      ...clientMeta(input),
    });
    throw new DomainError('invalid_credentials');
  }
  if (!passwordOk) {
    await registerFailure(ctx, user.id, clientMeta(input), 'login.failed');
    throw new DomainError('invalid_credentials');
  }

  const memberships = await withUser(ctx.db, user.id, (tx) =>
    tx
      .select({ accountId: accountUsers.accountId })
      .from(accountUsers)
      .where(eq(accountUsers.userId, user.id))
      .orderBy(asc(accountUsers.createdAt)),
  );
  const chosen = input.accountId
    ? memberships.find((m) => m.accountId === input.accountId)
    : memberships[0];
  if (!chosen) throw new DomainError('invalid_credentials');
  const accountId = chosen.accountId;

  const enrolled = await hasConfirmedTotp(ctx, user.id);
  if (enrolled) {
    return {
      status: 'mfa_required',
      challenge: await signChallenge(ctx, { sub: user.id, acc: accountId, purpose: 'mfa' }),
    };
  }
  const [account] = await withTenant(ctx.db, accountId, (tx) =>
    tx
      .select({ require2fa: accounts.require2fa })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1),
  );
  if (account?.require2fa) {
    return {
      status: 'mfa_enrollment_required',
      challenge: await signChallenge(ctx, { sub: user.id, acc: accountId, purpose: 'enroll' }),
    };
  }
  return {
    status: 'authenticated',
    accountId,
    tokens: await finishLogin(ctx, user.id, accountId, null, clientMeta(input)),
  };
}

async function finishLogin(
  ctx: Ctx,
  userId: string,
  accountId: string,
  mfaVerifiedAt: Date | null,
  meta: ClientMeta,
): Promise<TokenPair> {
  const now = ctx.now();
  await ctx.db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now })
    .where(eq(users.id, userId));
  return withTenant(ctx.db, accountId, async (tx) => {
    const tokens = await startSession(tx, ctx, {
      userId,
      accountId,
      mfaVerifiedAt,
      ...clientMeta(meta),
    });
    await recordAudit(tx, {
      accountId,
      actorUserId: userId,
      action: 'login.success',
      metadata: { mfa: mfaVerifiedAt !== null },
      ...clientMeta(meta),
    });
    return tokens;
  });
}

async function assertNotLocked(ctx: Ctx, userId: string): Promise<void> {
  const [u] = await ctx.db
    .select({ lockedUntil: users.lockedUntil, disabledAt: users.disabledAt })
    .from(users)
    .where(and(eq(users.id, userId)))
    .limit(1);
  if (!u || u.disabledAt || (u.lockedUntil && u.lockedUntil > ctx.now()))
    throw new DomainError('invalid_credentials');
}

/** Segundo passo: código TOTP ou de recuperação. Falhas contam para o mesmo bloqueio progressivo da senha. */
export async function completeMfaLogin(
  ctx: Ctx,
  input: { challenge: string; factor: SecondFactor } & ClientMeta,
): Promise<{ accountId: string; tokens: TokenPair }> {
  const claims = await verifyChallenge(ctx, input.challenge, 'mfa');
  await assertNotLocked(ctx, claims.sub);

  if (!(await verifySecondFactor(ctx, claims.sub, input.factor))) {
    await registerFailure(ctx, claims.sub, clientMeta(input), 'mfa.failed');
    throw new DomainError('invalid_mfa_code');
  }
  const tokens = await finishLogin(ctx, claims.sub, claims.acc, ctx.now(), clientMeta(input));
  return { accountId: claims.acc, tokens };
}

/** Para contas que exigem 2FA: o usuário sem fator confirma o cadastro do TOTP e já entra. */
export async function completeEnrollmentLogin(
  ctx: Ctx,
  input: { challenge: string; code: string } & ClientMeta,
): Promise<{ accountId: string; tokens: TokenPair; recoveryCodes: string[] }> {
  const claims = await verifyChallenge(ctx, input.challenge, 'enroll');
  await assertNotLocked(ctx, claims.sub);
  try {
    const { recoveryCodes } = await confirmTotpEnrollment(ctx, claims.sub, input.code);
    const tokens = await finishLogin(ctx, claims.sub, claims.acc, ctx.now(), clientMeta(input));
    return { accountId: claims.acc, tokens, recoveryCodes };
  } catch (e) {
    if (e instanceof DomainError && e.code === 'invalid_mfa_code')
      await registerFailure(ctx, claims.sub, clientMeta(input), 'mfa.failed');
    throw e;
  }
}
