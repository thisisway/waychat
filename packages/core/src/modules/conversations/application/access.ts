import { schema, type Tx } from '@waychat/db';
import { and, eq, sql } from 'drizzle-orm';
import { DomainError } from '../../../errors.js';
import type { Actor } from '../../authz/application/actor.js';

const { conversations, inboxMembers } = schema;

/**
 * "Agora" com precisão de milissegundo. O Postgres guarda microssegundos e o JavaScript só milissegundos:
 * cursores de paginação montados a partir de um `Date` perderiam a diferença e pulariam ou repetiriam linhas.
 * Truncar na gravação faz o valor do banco e o do cursor serem idênticos.
 */
export const nowMs = sql`date_trunc('milliseconds', now())`;

export type ConversationRow = typeof conversations.$inferSelect;

/** Pode listar/ler conversas? `read_all` enxerga todas as inboxes; `read` só as de que é membro. */
export function assertCanRead(actor: Actor): void {
  if (
    !actor.permissions.has('conversations:read') &&
    !actor.permissions.has('conversations:read_all')
  ) {
    throw new DomainError('forbidden', 'falta a permissão conversations:read');
  }
}

export const seesAllInboxes = (actor: Actor) => actor.permissions.has('conversations:read_all');

/** Inboxes de que o usuário é membro (dentro da transação do tenant). */
export async function memberInboxIds(tx: Tx, actor: Actor): Promise<string[]> {
  const rows = await tx
    .select({ inboxId: inboxMembers.inboxId })
    .from(inboxMembers)
    .where(eq(inboxMembers.userId, actor.userId));
  return rows.map((r) => r.inboxId);
}

/**
 * Carrega a conversa SE o usuário puder vê-la. Conversa inexistente e conversa de inbox alheia dão o mesmo
 * `not_found`: quem não tem acesso não descobre que ela existe (nem por tempo, pois a consulta é a mesma).
 * Esta é a regra de visibilidade (D5) usada por REST, `/sync` e WebSocket.
 */
export async function loadVisibleConversation(
  tx: Tx,
  actor: Actor,
  conversationId: string,
): Promise<ConversationRow> {
  assertCanRead(actor);
  const [row] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) throw new DomainError('not_found');
  if (seesAllInboxes(actor)) return row;
  const [member] = await tx
    .select({ u: inboxMembers.userId })
    .from(inboxMembers)
    .where(and(eq(inboxMembers.inboxId, row.inboxId), eq(inboxMembers.userId, actor.userId)))
    .limit(1);
  if (!member) throw new DomainError('not_found');
  return row;
}
