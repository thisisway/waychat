import { schema, type Tx } from '@waychat/db';
import {
  currentTraceContext,
  eventPayloadSchemas,
  type EventPayload,
  type EventType,
} from '@waychat/shared';

/**
 * Transactional Outbox: chame DENTRO da mesma transação que muda o estado.
 * Se a transação der rollback o evento some junto; se der commit, o relay do worker o publica.
 */
export async function enqueueEvent<T extends EventType>(
  tx: Tx,
  event: {
    accountId: string;
    aggregateType: string;
    aggregateId: string;
    type: T;
    payload: EventPayload<T>;
  },
): Promise<void> {
  const payload = eventPayloadSchemas[event.type].parse(event.payload) as Record<string, unknown>;
  await tx.insert(schema.outbox).values({
    accountId: event.accountId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    eventType: event.type,
    payload,
    traceContext: currentTraceContext() ?? null,
  });
}
