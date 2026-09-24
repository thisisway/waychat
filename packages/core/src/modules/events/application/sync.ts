import { schema, withTenant } from '@waychat/db';
import { eventEnvelopeSchema, type EventEnvelope } from '@waychat/shared';
import { asc, gt, sql } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { DomainError } from '../../../errors.js';
import type { Actor } from '../../authz/application/actor.js';
import { canSeeEvent, loadEventScope } from './visibility.js';

const { outbox } = schema;
const PAGE = 500;

export interface SyncResult {
  events: EventEnvelope[];
  /** Último cursor examinado: o cliente continua a partir dele (eventos invisíveis a ele também avançam o cursor). */
  cursor: number;
  hasMore: boolean;
}

/** Cursor atual da conta (maior `account_seq`): ponto de partida de um cliente novo. */
export async function currentCursor(ctx: Ctx, actor: Actor): Promise<number> {
  const [row] = await withTenant(ctx.db, actor.accountId, (tx) =>
    tx.select({ max: sql<number>`coalesce(max(${outbox.accountSeq}), 0)::int` }).from(outbox),
  );
  return row?.max ?? 0;
}

/**
 * Eventos depois de `since`, na ordem do cursor e filtrados pela visibilidade do usuário.
 * Como o cursor é por conta e sem lacunas (ADR 0006), "tudo depois de N" é completo: nenhum evento confirmado
 * depois pode ter número menor. É a base da recuperação após reconexão.
 */
export async function listEventsSince(
  ctx: Ctx,
  actor: Actor,
  since: number,
  limit = 200,
): Promise<SyncResult> {
  if (!Number.isInteger(since) || since < 0)
    throw new DomainError('invalid_input', 'cursor inválido');
  const max = Math.min(Math.max(limit, 1), 500);
  const scope = await loadEventScope(ctx, actor);

  const events: EventEnvelope[] = [];
  let cursor = since;
  let hasMore = false;

  // Varre em páginas até juntar `max` eventos VISÍVEIS (a maioria dos eventos da conta pode ser de outras inboxes).
  for (;;) {
    const rows = await withTenant(ctx.db, actor.accountId, (tx) =>
      tx
        .select()
        .from(outbox)
        .where(gt(outbox.accountSeq, cursor))
        .orderBy(asc(outbox.accountSeq))
        .limit(PAGE),
    );
    for (const r of rows) {
      cursor = r.accountSeq;
      const env = eventEnvelopeSchema.parse({
        event_id: r.id,
        cursor: r.accountSeq,
        account_id: r.accountId,
        type: r.eventType,
        occurred_at: r.createdAt.toISOString(),
        ...(r.traceContext ? { trace_context: r.traceContext } : {}),
        payload: r.payload,
      });
      if (canSeeEvent(scope, env)) {
        events.push(env);
        if (events.length >= max) {
          hasMore = true; // pode haver mais depois deste ponto
          return { events, cursor, hasMore };
        }
      }
    }
    if (rows.length < PAGE) return { events, cursor, hasMore };
  }
}
