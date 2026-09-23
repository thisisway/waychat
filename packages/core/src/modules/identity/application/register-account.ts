import { schema, withTenant } from '@waychat/db';
import { SYSTEM_ROLES, uuidv7, type SystemRoleName } from '@waychat/shared';
import type { Ctx } from '../../../context.js';
import { randomToken } from '../../../crypto/tokens.js';
import { uniqueViolation } from '../../../db-errors.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';
import { enqueueEvent } from '../../events/application/enqueue.js';
import { assertPasswordPolicy, normalizeEmail } from '../domain/password-policy.js';
import { hashPassword } from '../infra/password.js';
import type { ClientMeta } from './sessions.js';

const { accounts, users, roles, rolePermissions, accountUsers } = schema;

export interface RegisterAccountInput extends ClientMeta {
  accountName: string;
  /** Opcional; sem ele o slug é derivado do nome. */
  slug?: string;
  ownerName: string;
  email: string;
  password: string;
}

export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'conta';
}

/**
 * Cria conta + papéis de sistema + primeiro usuário (Owner) numa única transação, já sob a RLS do novo tenant.
 * Grava auditoria e o evento `account.created` no outbox.
 */
export async function registerAccount(
  ctx: Ctx,
  input: RegisterAccountInput,
): Promise<{ accountId: string; userId: string }> {
  const email = normalizeEmail(input.email);
  assertPasswordPolicy(input.password, email);
  const passwordHash = await hashPassword(input.password); // fora da transação: é lento de propósito

  const accountId = uuidv7();
  const userId = uuidv7();
  const slug =
    input.slug ??
    `${slugify(input.accountName)}-${randomToken(3)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}`;

  try {
    await withTenant(ctx.db, accountId, async (tx) => {
      await tx.insert(accounts).values({ id: accountId, name: input.accountName, slug });
      await tx.insert(users).values({ id: userId, email, name: input.ownerName, passwordHash });

      let ownerRoleId = '';
      for (const [name, permissions] of Object.entries(SYSTEM_ROLES) as [
        SystemRoleName,
        readonly string[],
      ][]) {
        const [role] = await tx
          .insert(roles)
          .values({ accountId, name, isSystem: true })
          .returning({ id: roles.id });
        if (!role) throw new Error('falha ao criar papel de sistema');
        if (name === 'Owner') ownerRoleId = role.id;
        await tx
          .insert(rolePermissions)
          .values(permissions.map((permission) => ({ roleId: role.id, accountId, permission })));
      }
      await tx.insert(accountUsers).values({ accountId, userId, roleId: ownerRoleId });

      await recordAudit(tx, {
        accountId,
        actorUserId: userId,
        action: 'account.created',
        targetType: 'account',
        targetId: accountId,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
      await enqueueEvent(tx, {
        accountId,
        aggregateType: 'account',
        aggregateId: accountId,
        type: 'account.created',
        payload: { name: input.accountName, owner_user_id: userId },
      });
    });
  } catch (e) {
    const constraint = uniqueViolation(e);
    if (constraint?.includes('users_email')) throw new DomainError('email_taken');
    if (constraint?.includes('slug')) throw new DomainError('slug_taken');
    throw e;
  }
  return { accountId, userId };
}
