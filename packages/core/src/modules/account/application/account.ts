import { schema, withTenant } from '@waychat/db';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';

const { accounts, users, accountUsers, roles } = schema;

export interface MeView {
  user: { id: string; name: string; email: string; locale: string };
  account: { id: string; name: string; slug: string; require2fa: boolean };
  role: { id: string; name: string };
  permissions: string[];
}

/** Perfil de quem está autenticado. Nenhuma permissão específica: cada um vê a si mesmo. */
export async function getMe(ctx: Ctx, actor: Actor): Promise<MeView> {
  const [user] = await ctx.db
    .select({ id: users.id, name: users.name, email: users.email, locale: users.locale })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  if (!user) throw new DomainError('not_found');
  const found = await withTenant(ctx.db, actor.accountId, async (tx) => {
    const [account] = await tx
      .select({
        id: accounts.id,
        name: accounts.name,
        slug: accounts.slug,
        require2fa: accounts.require2fa,
      })
      .from(accounts)
      .where(eq(accounts.id, actor.accountId))
      .limit(1);
    const [role] = await tx
      .select({ id: roles.id, name: roles.name })
      .from(accountUsers)
      .innerJoin(roles, eq(roles.id, accountUsers.roleId))
      .where(eq(accountUsers.userId, actor.userId))
      .limit(1);
    return { account, role };
  });
  if (!found.account || !found.role) throw new DomainError('not_found');
  return {
    user,
    account: found.account,
    role: found.role,
    permissions: [...actor.permissions].sort(),
  };
}

export async function getAccount(ctx: Ctx, actor: Actor) {
  assertCan(actor, 'account:read');
  const [account] = await withTenant(ctx.db, actor.accountId, (tx) =>
    tx.select().from(accounts).where(eq(accounts.id, actor.accountId)).limit(1),
  );
  if (!account) throw new DomainError('not_found');
  return { id: account.id, name: account.name, slug: account.slug, require2fa: account.require2fa };
}

export async function updateAccount(
  ctx: Ctx,
  actor: Actor,
  input: { name?: string; require2fa?: boolean },
): Promise<void> {
  assertCan(actor, 'account:update');
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    await tx
      .update(accounts)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.require2fa !== undefined ? { require2fa: input.require2fa } : {}),
      })
      .where(eq(accounts.id, actor.accountId));
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'account.updated',
      targetType: 'account',
      targetId: actor.accountId,
      metadata: input,
    });
  });
}
