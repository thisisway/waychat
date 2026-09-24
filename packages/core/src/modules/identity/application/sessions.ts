import { schema, withTenant, type Tx } from '@waychat/db';
import { uuidv7, type Permission } from '@waychat/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { randomToken, sha256Hex } from '../../../crypto/tokens.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';
import { signAccessToken, verifyAccessToken } from '../infra/jwt.js';

const { sessions, users, accountUsers, rolePermissions } = schema;

export interface ClientMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Copia só ip/userAgent. Nunca espalhe (`...`) um objeto de entrada em auditoria/sessão: ele pode carregar senha ou accountId. */
export function clientMeta(m: ClientMeta): ClientMeta {
  return { ip: m.ip ?? null, userAgent: m.userAgent ?? null };
}

export interface TokenPair {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface AuthenticatedActor {
  userId: string;
  accountId: string;
  /** Identificador da família de sessão (cadeia de refresh), o mesmo do access token. */
  familyId: string;
  mfaVerified: boolean;
  permissions: ReadonlySet<Permission>;
}

interface IssueParams extends ClientMeta {
  userId: string;
  accountId: string;
  familyId: string;
  sessionId: string;
  mfaVerifiedAt: Date | null;
}

/** Cria a linha de sessão (refresh só em hash) e assina o access token. Chamar dentro de `withTenant`. */
export async function issueSession(tx: Tx, ctx: Ctx, p: IssueParams): Promise<TokenPair> {
  const now = ctx.now();
  const refreshToken = randomToken();
  const refreshExpiresAt = new Date(now.getTime() + ctx.config.refreshTtlSeconds * 1000);
  await tx.insert(sessions).values({
    id: p.sessionId,
    userId: p.userId,
    accountId: p.accountId,
    familyId: p.familyId,
    refreshHash: sha256Hex(refreshToken),
    expiresAt: refreshExpiresAt,
    mfaVerifiedAt: p.mfaVerifiedAt,
    ip: p.ip ?? null,
    userAgent: p.userAgent?.slice(0, 300) ?? null,
    lastUsedAt: now,
  });
  const access = await signAccessToken(ctx, {
    sub: p.userId,
    acc: p.accountId,
    fam: p.familyId,
    mfa: p.mfaVerifiedAt !== null,
  });
  return {
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken,
    refreshExpiresAt,
  };
}

/** Sessão nova (login): abre uma família. */
export function startSession(
  tx: Tx,
  ctx: Ctx,
  p: { userId: string; accountId: string; mfaVerifiedAt: Date | null } & ClientMeta,
): Promise<TokenPair> {
  return issueSession(tx, ctx, { ...p, familyId: uuidv7(), sessionId: uuidv7() });
}

export async function loadPermissions(
  tx: Tx,
  accountId: string,
  userId: string,
): Promise<Set<Permission> | null> {
  const member = await tx
    .select({ roleId: accountUsers.roleId })
    .from(accountUsers)
    .where(and(eq(accountUsers.accountId, accountId), eq(accountUsers.userId, userId)))
    .limit(1);
  if (!member[0]) return null;
  const rows = await tx
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, member[0].roleId));
  return new Set(rows.map((r) => r.permission as Permission));
}

/**
 * Estado atual de uma sessão: a família de refresh precisa estar ativa e o usuário ainda ser membro da conta.
 * Devolve `null` se não estiver. NÃO olha a validade do access token: serve a conexões longas (WebSocket), que
 * sobrevivem ao access token de 10 min enquanto a sessão (o refresh) continuar válida.
 */
export async function actorForSession(
  ctx: Ctx,
  s: { userId: string; accountId: string; familyId: string; mfaVerified: boolean },
): Promise<AuthenticatedActor | null> {
  const active = await ctx.db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.familyId, s.familyId),
        eq(sessions.userId, s.userId),
        eq(sessions.accountId, s.accountId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, ctx.now()),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  if (!active[0]) return null;
  const permissions = await withTenant(ctx.db, s.accountId, (tx) =>
    loadPermissions(tx, s.accountId, s.userId),
  );
  if (!permissions) return null; // removido da conta depois do login
  return {
    userId: s.userId,
    accountId: s.accountId,
    familyId: s.familyId,
    mfaVerified: s.mfaVerified,
    permissions,
  };
}

/** Valida o access token, confirma que a família de sessão continua ativa e carrega as permissões atuais. */
export async function authenticate(ctx: Ctx, accessToken: string): Promise<AuthenticatedActor> {
  const claims = await verifyAccessToken(ctx, accessToken);
  const actor = await actorForSession(ctx, {
    userId: claims.sub,
    accountId: claims.acc,
    familyId: claims.fam,
    mfaVerified: claims.mfa,
  });
  if (!actor) throw new DomainError('invalid_token');
  return actor;
}

async function revokeFamily(ctx: Ctx, familyId: string, reason: string): Promise<void> {
  await ctx.db
    .update(sessions)
    .set({ revokedAt: ctx.now(), revokedReason: reason })
    .where(and(eq(sessions.familyId, familyId), isNull(sessions.revokedAt)));
}

/**
 * Troca o refresh token por um par novo (rotação). O token antigo passa a valer zero.
 * Se um token JÁ rotacionado for apresentado de novo, alguém o copiou: a família inteira é revogada
 * (vale para o atacante e para o usuário legítimo, que precisa autenticar de novo).
 */
export async function refreshSession(
  ctx: Ctx,
  refreshToken: string,
  meta: ClientMeta = {},
): Promise<TokenPair> {
  const now = ctx.now();
  const rows = await ctx.db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshHash, sha256Hex(refreshToken)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new DomainError('invalid_token');

  const reuse = async () => {
    await revokeFamily(ctx, row.familyId, 'reuse_detected');
    await withTenant(ctx.db, row.accountId, (tx) =>
      recordAudit(tx, {
        accountId: row.accountId,
        actorUserId: row.userId,
        action: 'session.refresh_reuse_detected',
        targetType: 'session_family',
        targetId: row.familyId,
        ...clientMeta(meta),
      }),
    );
    throw new DomainError('invalid_token');
  };

  if (row.revokedAt) {
    if (row.replacedBy) return reuse();
    throw new DomainError('invalid_token'); // revogado explicitamente (logout, remoção da conta...)
  }
  if (row.expiresAt <= now) throw new DomainError('invalid_token');

  const outcome = await withTenant(ctx.db, row.accountId, async (tx) => {
    const perms = await loadPermissions(tx, row.accountId, row.userId);
    const [user] = await tx
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (!perms || !user || user.disabledAt) return 'denied' as const;

    const newId = uuidv7();
    // UPDATE condicional: só uma requisição concorrente vence a rotação; a outra vê 0 linhas.
    const claimed = await tx
      .update(sessions)
      .set({ revokedAt: now, revokedReason: 'rotated', replacedBy: newId, lastUsedAt: now })
      .where(and(eq(sessions.id, row.id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (claimed.length === 0) return 'raced' as const;

    return issueSession(tx, ctx, {
      userId: row.userId,
      accountId: row.accountId,
      familyId: row.familyId,
      sessionId: newId,
      mfaVerifiedAt: row.mfaVerifiedAt,
      ...clientMeta(meta),
    });
  });

  if (outcome === 'denied') {
    await revokeFamily(ctx, row.familyId, 'membership_or_user_invalid');
    throw new DomainError('invalid_token');
  }
  if (outcome === 'raced') return reuse();
  return outcome;
}

/** Encerra a sessão (logout). Idempotente. */
export async function logout(
  ctx: Ctx,
  actor: Pick<AuthenticatedActor, 'userId' | 'accountId' | 'familyId'>,
): Promise<void> {
  await revokeFamily(ctx, actor.familyId, 'logout');
  await withTenant(ctx.db, actor.accountId, (tx) =>
    recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'session.logout',
      targetId: actor.familyId,
    }),
  );
}

export interface SessionSummary {
  familyId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Sessões ativas do usuário na conta atual (uma linha por família). */
export async function listSessions(ctx: Ctx, actor: AuthenticatedActor): Promise<SessionSummary[]> {
  const rows = await ctx.db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, actor.userId),
        eq(sessions.accountId, actor.accountId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, ctx.now()),
      ),
    );
  return rows.map((r) => ({
    familyId: r.familyId,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    ip: r.ip,
    userAgent: r.userAgent,
    current: r.familyId === actor.familyId,
  }));
}

/** Revoga uma sessão do próprio usuário (ou todas, com `familyId` omitido). */
export async function revokeOwnSessions(
  ctx: Ctx,
  actor: AuthenticatedActor,
  familyId?: string,
): Promise<void> {
  const filters = [eq(sessions.userId, actor.userId), isNull(sessions.revokedAt)];
  if (familyId) filters.push(eq(sessions.familyId, familyId));
  await ctx.db
    .update(sessions)
    .set({ revokedAt: ctx.now(), revokedReason: 'revoked_by_user' })
    .where(and(...filters));
  await withTenant(ctx.db, actor.accountId, (tx) =>
    recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: familyId ? 'session.revoked' : 'session.revoked_all',
      targetId: familyId ?? actor.userId,
    }),
  );
}
