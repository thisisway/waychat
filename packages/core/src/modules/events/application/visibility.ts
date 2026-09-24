import { schema, withTenant } from '@waychat/db';
import { eq } from 'drizzle-orm';
import type { EventEnvelope } from '@waychat/shared';
import type { Ctx } from '../../../context.js';
import type { Actor } from '../../authz/application/actor.js';

/**
 * O que um usuário pode enxergar (D5). É a MESMA regra para o `GET /sync` e para o WebSocket: um evento só
 * chega a quem também poderia obter aquele dado pela API.
 */
export interface EventScope {
  actor: Actor;
  /** `read_all`: todas as inboxes. */
  allInboxes: boolean;
  /** Inboxes de que o usuário é membro. */
  inboxIds: ReadonlySet<string>;
}

export async function loadEventScope(ctx: Ctx, actor: Actor): Promise<EventScope> {
  const rows = await withTenant(ctx.db, actor.accountId, (tx) =>
    tx
      .select({ inboxId: schema.inboxMembers.inboxId })
      .from(schema.inboxMembers)
      .where(eq(schema.inboxMembers.userId, actor.userId)),
  );
  return {
    actor,
    allInboxes: actor.permissions.has('conversations:read_all'),
    inboxIds: new Set(rows.map((r) => r.inboxId)),
  };
}

const can = (scope: EventScope, p: Parameters<Actor['permissions']['has']>[0]) =>
  scope.actor.permissions.has(p);

function inInbox(scope: EventScope, payload: Record<string, unknown>): boolean {
  const inboxId = payload['inbox_id'];
  return typeof inboxId === 'string' && (scope.allInboxes || scope.inboxIds.has(inboxId));
}

/**
 * Deny-by-default: tipo de evento desconhecido nunca é entregue.
 * Conversas e mensagens (inclusive notas internas, que são da equipe) dependem da inbox; o resto, de uma permissão.
 */
export function canSeeEvent(
  scope: EventScope,
  event: Pick<EventEnvelope, 'type' | 'account_id' | 'payload'>,
): boolean {
  if (event.account_id !== scope.actor.accountId) return false;
  const canRead = can(scope, 'conversations:read') || can(scope, 'conversations:read_all');
  const family = event.type.split('.')[0];
  switch (family) {
    case 'conversation':
    case 'message':
      return canRead && inInbox(scope, event.payload);
    case 'inbox':
      return can(scope, 'inboxes:read') || inInbox(scope, event.payload);
    case 'contact':
      return can(scope, 'contacts:read');
    case 'member':
      return can(scope, 'members:read');
    case 'account':
      return can(scope, 'account:read');
    default:
      return false;
  }
}
