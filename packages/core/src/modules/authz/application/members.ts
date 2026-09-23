import { schema, withTenant } from '@waychat/db';
import { OWNER_ROLE, uuidv7 } from '@waychat/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';
import { enqueueEvent } from '../../events/application/enqueue.js';
import { assertPasswordPolicy, normalizeEmail } from '../../identity/domain/password-policy.js';
import { hashPassword } from '../../identity/infra/password.js';
import { assertCan, assertCanGrant, type Actor } from './actor.js';

const { accountUsers, roles, rolePermissions, users, sessions } = schema;

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
}

export async function listMembers(ctx: Ctx, actor: Actor): Promise<MemberView[]> {
  assertCan(actor, 'members:read');
  return withTenant(ctx.db, actor.accountId, (tx) =>
    tx
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        roleId: roles.id,
        roleName: roles.name,
      })
      .from(accountUsers)
      .innerJoin(users, eq(users.id, accountUsers.userId))
      .innerJoin(roles, eq(roles.id, accountUsers.roleId))
      .orderBy(accountUsers.createdAt),
  );
}

type Tx = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];

/** Um papel só pode ser atribuído por quem já tem todas as permissões dele (anti-escalada). */
async function assertCanAssignRole(
  tx: Tx,
  actor: Actor,
  roleId: string,
): Promise<{ name: string }> {
  const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) throw new DomainError('not_found');
  const perms = await tx
    .select({ p: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  assertCanGrant(
    actor,
    perms.map((r) => r.p),
  );
  return { name: role.name };
}

/** Garante que a conta nunca fique sem Owner. Trava as linhas de Owner (FOR UPDATE) para fechar a corrida entre duas remoções. */
async function assertNotLastOwner(tx: Tx, accountId: string, targetUserId: string): Promise<void> {
  const owners = await tx
    .select({ userId: accountUsers.userId })
    .from(accountUsers)
    .innerJoin(roles, eq(roles.id, accountUsers.roleId))
    .where(
      and(
        eq(accountUsers.accountId, accountId),
        eq(roles.name, OWNER_ROLE),
        eq(roles.isSystem, true),
      ),
    )
    .for('update', { of: accountUsers });
  if (owners.length === 1 && owners[0]?.userId === targetUserId)
    throw new DomainError('last_owner');
}

/**
 * Adiciona alguém à conta. Se o e-mail já existe, vincula o usuário existente (a senha informada é ignorada);
 * senão cria o usuário com a senha informada. Convite por e-mail fica no backlog (depende do canal de e-mail).
 */
export async function addMember(
  ctx: Ctx,
  actor: Actor,
  input: { email: string; name: string; password: string; roleId: string },
): Promise<{ userId: string; created: boolean }> {
  assertCan(actor, 'members:manage');
  const email = normalizeEmail(input.email);
  const [existing] = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  let passwordHash: string | undefined;
  if (!existing) {
    assertPasswordPolicy(input.password, email);
    passwordHash = await hashPassword(input.password);
  }

  return withTenant(ctx.db, actor.accountId, async (tx) => {
    await assertCanAssignRole(tx, actor, input.roleId);
    const userId = existing?.id ?? uuidv7();
    if (passwordHash)
      await tx.insert(users).values({ id: userId, email, name: input.name.trim(), passwordHash });
    const already = await tx
      .select({ u: accountUsers.userId })
      .from(accountUsers)
      .where(and(eq(accountUsers.accountId, actor.accountId), eq(accountUsers.userId, userId)));
    if (already.length > 0) throw new DomainError('email_taken', 'já é membro desta conta');
    await tx
      .insert(accountUsers)
      .values({ accountId: actor.accountId, userId, roleId: input.roleId });
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'member.added',
      targetType: 'user',
      targetId: userId,
      metadata: { role_id: input.roleId },
    });
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'user',
      aggregateId: userId,
      type: 'member.added',
      payload: { user_id: userId, role_id: input.roleId },
    });
    return { userId, created: !existing };
  });
}

export async function changeMemberRole(
  ctx: Ctx,
  actor: Actor,
  userId: string,
  roleId: string,
): Promise<void> {
  assertCan(actor, 'members:manage');
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    await assertCanAssignRole(tx, actor, roleId);
    const [current] = await tx
      .select({ roleId: accountUsers.roleId })
      .from(accountUsers)
      .where(and(eq(accountUsers.accountId, actor.accountId), eq(accountUsers.userId, userId)))
      .limit(1);
    if (!current) throw new DomainError('not_found');
    if (current.roleId !== roleId) await assertNotLastOwner(tx, actor.accountId, userId);
    await tx
      .update(accountUsers)
      .set({ roleId })
      .where(and(eq(accountUsers.accountId, actor.accountId), eq(accountUsers.userId, userId)));
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'member.role_changed',
      targetType: 'user',
      targetId: userId,
      metadata: { role_id: roleId },
    });
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'user',
      aggregateId: userId,
      type: 'member.role_changed',
      payload: { user_id: userId, role_id: roleId },
    });
  });
}

/** Remove da conta e derruba as sessões dele nesta conta imediatamente. */
export async function removeMember(ctx: Ctx, actor: Actor, userId: string): Promise<void> {
  assertCan(actor, 'members:manage');
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    await assertNotLastOwner(tx, actor.accountId, userId);
    const removed = await tx
      .delete(accountUsers)
      .where(and(eq(accountUsers.accountId, actor.accountId), eq(accountUsers.userId, userId)))
      .returning({ u: accountUsers.userId });
    if (removed.length === 0) throw new DomainError('not_found');
    await tx
      .update(sessions)
      .set({ revokedAt: ctx.now(), revokedReason: 'removed_from_account' })
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.accountId, actor.accountId),
          isNull(sessions.revokedAt),
        ),
      );
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'member.removed',
      targetType: 'user',
      targetId: userId,
    });
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'user',
      aggregateId: userId,
      type: 'member.removed',
      payload: { user_id: userId },
    });
  });
}
