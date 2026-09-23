import { schema, withTenant } from '@waychat/db';
import { isPermission } from '@waychat/shared';
import { and, count, eq } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { uniqueViolation } from '../../../db-errors.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';
import { assertCan, assertCanGrant, type Actor } from './actor.js';

const { roles, rolePermissions, accountUsers } = schema;

export interface RoleView {
  id: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}

function validatePermissions(permissions: readonly string[]): string[] {
  const unique = [...new Set(permissions)];
  const bad = unique.find((p) => !isPermission(p));
  if (bad) throw new DomainError('invalid_permission', `permissão desconhecida: ${bad}`);
  return unique;
}

export async function listRoles(ctx: Ctx, actor: Actor): Promise<RoleView[]> {
  assertCan(actor, 'roles:read');
  return withTenant(ctx.db, actor.accountId, async (tx) => {
    const rs = await tx.select().from(roles).orderBy(roles.createdAt);
    const ps = await tx.select().from(rolePermissions);
    return rs.map((r) => ({
      id: r.id,
      name: r.name,
      isSystem: r.isSystem,
      permissions: ps
        .filter((p) => p.roleId === r.id)
        .map((p) => p.permission)
        .sort(),
    }));
  });
}

export async function createRole(
  ctx: Ctx,
  actor: Actor,
  input: { name: string; permissions: string[] },
): Promise<{ id: string }> {
  assertCan(actor, 'roles:manage');
  const permissions = validatePermissions(input.permissions);
  assertCanGrant(actor, permissions);
  try {
    return await withTenant(ctx.db, actor.accountId, async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values({ accountId: actor.accountId, name: input.name.trim() })
        .returning({ id: roles.id });
      if (!role) throw new Error('falha ao criar papel');
      if (permissions.length > 0) {
        await tx.insert(rolePermissions).values(
          permissions.map((permission) => ({
            roleId: role.id,
            accountId: actor.accountId,
            permission,
          })),
        );
      }
      await recordAudit(tx, {
        accountId: actor.accountId,
        actorUserId: actor.userId,
        action: 'role.created',
        targetType: 'role',
        targetId: role.id,
        metadata: { name: input.name.trim(), permissions },
      });
      return role;
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new DomainError('name_taken');
    throw e;
  }
}

export async function updateRole(
  ctx: Ctx,
  actor: Actor,
  roleId: string,
  input: { name?: string; permissions?: string[] },
): Promise<void> {
  assertCan(actor, 'roles:manage');
  const permissions = input.permissions ? validatePermissions(input.permissions) : undefined;
  if (permissions) assertCanGrant(actor, permissions);
  try {
    await withTenant(ctx.db, actor.accountId, async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
      if (!role) throw new DomainError('not_found');
      if (role.isSystem) throw new DomainError('system_role_immutable');
      if (input.name)
        await tx.update(roles).set({ name: input.name.trim() }).where(eq(roles.id, roleId));
      if (permissions) {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
        if (permissions.length > 0) {
          await tx
            .insert(rolePermissions)
            .values(
              permissions.map((permission) => ({ roleId, accountId: actor.accountId, permission })),
            );
        }
      }
      await recordAudit(tx, {
        accountId: actor.accountId,
        actorUserId: actor.userId,
        action: 'role.updated',
        targetType: 'role',
        targetId: roleId,
        metadata: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(permissions ? { permissions } : {}),
        },
      });
    });
  } catch (e) {
    if (uniqueViolation(e)) throw new DomainError('name_taken');
    throw e;
  }
}

export async function deleteRole(ctx: Ctx, actor: Actor, roleId: string): Promise<void> {
  assertCan(actor, 'roles:manage');
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!role) throw new DomainError('not_found');
    if (role.isSystem) throw new DomainError('system_role_immutable');
    const [inUse] = await tx
      .select({ n: count() })
      .from(accountUsers)
      .where(and(eq(accountUsers.roleId, roleId)));
    if ((inUse?.n ?? 0) > 0) throw new DomainError('role_in_use');
    await tx.delete(roles).where(eq(roles.id, roleId));
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'role.deleted',
      targetType: 'role',
      targetId: roleId,
    });
  });
}
