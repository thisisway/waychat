import type { Permission } from '@waychat/shared';
import { DomainError } from '../../../errors.js';

/** Quem está agindo. Vem sempre de `authenticate()`; nunca do corpo da requisição. */
export interface Actor {
  userId: string;
  accountId: string;
  permissions: ReadonlySet<Permission>;
}

/** Deny-by-default: sem a permissão declarada, nada acontece. */
export function assertCan(actor: Actor, permission: Permission): void {
  if (!actor.permissions.has(permission))
    throw new DomainError('forbidden', `falta a permissão ${permission}`);
}

/**
 * Anti-escalada de privilégio: ninguém concede (via papel novo, edição de papel ou atribuição) permissão que não possui.
 * Sem isso, quem tem só `roles:manage` viraria dono da conta criando um papel com tudo.
 */
export function assertCanGrant(actor: Actor, permissions: Iterable<string>): void {
  for (const p of permissions) {
    if (!actor.permissions.has(p as Permission))
      throw new DomainError('privilege_escalation', `você não possui ${p}`);
  }
}
