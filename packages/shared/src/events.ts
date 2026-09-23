import { z } from 'zod';

/**
 * Contrato dos eventos publicados pelo outbox (WebSocket, automações, webhooks).
 * `cursor` cresce de forma monotônica por escrita; o cliente deduplica por `event_id`.
 */
export const eventEnvelopeSchema = z.object({
  event_id: z.uuid(),
  cursor: z.number().int().nonnegative(),
  account_id: z.uuid(),
  type: z.string().min(1),
  occurred_at: z.iso.datetime(),
  /** W3C `traceparent` da requisição de origem; o worker continua o mesmo trace. */
  trace_context: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Tipos de evento existentes. Cada fase acrescenta os seus aqui, com o schema do payload. */
export const eventPayloadSchemas = {
  'account.created': z.object({ name: z.string(), owner_user_id: z.uuid() }),
  'member.added': z.object({ user_id: z.uuid(), role_id: z.uuid() }),
  'member.role_changed': z.object({ user_id: z.uuid(), role_id: z.uuid() }),
  'member.removed': z.object({ user_id: z.uuid() }),
  // Só ids: quem precisa dos dados busca pela API, já com a checagem de permissão (nada de PII no evento).
  'inbox.created': z.object({ inbox_id: z.uuid() }),
  'inbox.updated': z.object({ inbox_id: z.uuid() }),
  'inbox.deleted': z.object({ inbox_id: z.uuid() }),
  'contact.created': z.object({ contact_id: z.uuid() }),
  'contact.updated': z.object({ contact_id: z.uuid() }),
  'contact.deleted': z.object({ contact_id: z.uuid() }),
} as const;

export type EventType = keyof typeof eventPayloadSchemas;
export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloadSchemas)[T]>;
