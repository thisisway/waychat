import type { NormalizedEvent } from '@waychat/channels';
import { schema, withTenant } from '@waychat/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { DomainError } from '../../../errors.js';
import type { WhatsAppTarget } from '../../inbox/application/whatsapp.js';

const { inboundEvents } = schema;

/** Chave de deduplicação: a mesma entrega repetida pela Meta cai sempre na mesma chave. */
export function externalIdOf(e: NormalizedEvent, today: string): string {
  switch (e.kind) {
    case 'message':
      return `msg:${e.providerId}`;
    case 'status':
      return `st:${e.providerId}:${e.status}`;
    case 'template_status':
      return `tpl:${e.providerTemplateId}:${e.status}`;
    case 'quality':
      // o webhook de qualidade não traz id nem horário: um mesmo evento por dia
      return `q:${e.displayPhone}:${e.event}:${e.tier ?? ''}:${today}`;
  }
}

/** Datas viram texto ISO: é o que fica gravado (e o que o worker lê de volta). */
const toJson = (e: NormalizedEvent): Record<string, unknown> =>
  JSON.parse(JSON.stringify(e)) as Record<string, unknown>;

export interface WebhookIntake {
  /** Eventos novos gravados. */
  received: number;
  /** Já tinham sido gravados antes (reentrega): não geram nada de novo. */
  duplicates: number;
  /** De outro número/conta: descartados. */
  ignored: number;
}

/**
 * Grava os eventos de um webhook JÁ AUTENTICADO (assinatura conferida pelo chamador) e os enfileira.
 *  - a unicidade `(inbox, external_id)` do banco é a barreira contra webhook duplicado;
 *  - evento cujo número/conta não é o da inbox é descartado (não deixa uma conta injetar dados noutra);
 *  - se um reenvio da Meta chega quando a linha existe mas o job nunca foi enfileirado (Valkey fora do ar na
 *    primeira vez), ele é enfileirado agora: `jobId` fixo impede job duplicado.
 */
export async function acceptWhatsAppEvents(
  ctx: Ctx,
  target: WhatsAppTarget,
  events: NormalizedEvent[],
): Promise<WebhookIntake> {
  const today = ctx.now().toISOString().slice(0, 10);
  const mine = events.filter((e) =>
    e.kind === 'message' || e.kind === 'status'
      ? e.accountRef === target.config.phoneNumberId
      : e.wabaId === target.config.wabaId,
  );
  const ignored = events.length - mine.length;
  if (mine.length === 0) return { received: 0, duplicates: 0, ignored };

  const byKey = new Map(mine.map((e) => [externalIdOf(e, today), e] as const));
  const keys = [...byKey.keys()];
  const { inserted, pending } = await withTenant(ctx.db, target.accountId, async (tx) => {
    const created = await tx
      .insert(inboundEvents)
      .values(
        [...byKey].map(([externalId, e]) => ({
          accountId: target.accountId,
          inboxId: target.inboxId,
          externalId,
          payload: toJson(e),
        })),
      )
      .onConflictDoNothing({ target: [inboundEvents.inboxId, inboundEvents.externalId] })
      .returning({ id: inboundEvents.id });
    const open = await tx
      .select({ id: inboundEvents.id })
      .from(inboundEvents)
      .where(
        and(
          eq(inboundEvents.inboxId, target.inboxId),
          inArray(inboundEvents.externalId, keys),
          eq(inboundEvents.status, 'received'),
        ),
      );
    return { inserted: created.length, pending: open };
  });

  if (!ctx.channels) throw new DomainError('invalid_input', 'canais não estão habilitados');
  for (const p of pending) {
    await ctx.channels.enqueueInbound({
      accountId: target.accountId,
      inboxId: target.inboxId,
      eventId: p.id,
    });
  }
  return { received: inserted, duplicates: byKey.size - inserted, ignored };
}

const KNOWN_KINDS = new Set(['message', 'status', 'template_status', 'quality']);

/**
 * Desfaz `toJson`: revive `at` (guardado como texto ISO) de volta para `Date`. O resto do formato já foi
 * validado pelo `parseWebhook` antes de ser gravado — aqui só desfaz o que o JSON.stringify não preserva.
 */
function reviveEvent(raw: Record<string, unknown>): NormalizedEvent {
  if (!KNOWN_KINDS.has(raw['kind'] as string)) {
    throw new Error(`evento de entrada com "kind" desconhecido: ${String(raw['kind'])}`);
  }
  const at = raw['at'];
  return (typeof at === 'string' ? { ...raw, at: new Date(at) } : raw) as NormalizedEvent;
}

export interface InboundEventRow {
  id: string;
  status: string;
  event: NormalizedEvent;
}

/** Lê de volta um evento gravado por `acceptWhatsAppEvents` (o worker chama para processar o job). */
export async function loadInboundEvent(
  ctx: Ctx,
  accountId: string,
  eventId: string,
): Promise<InboundEventRow | null> {
  const row = await withTenant(ctx.db, accountId, async (tx) => {
    const [r] = await tx.select().from(inboundEvents).where(eq(inboundEvents.id, eventId)).limit(1);
    return r;
  });
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    event: reviveEvent(row.payload as Record<string, unknown>),
  };
}

/**
 * Processado com sucesso. Em falha, o chamador deixa a exceção subir (o BullMQ repete com backoff) e a linha
 * fica `received` — a próxima tentativa reprocessa do zero (o processamento em si é idempotente por `sourceId`).
 */
export async function markInboundEventProcessed(
  ctx: Ctx,
  accountId: string,
  eventId: string,
): Promise<void> {
  await withTenant(ctx.db, accountId, (tx) =>
    tx
      .update(inboundEvents)
      .set({ status: 'processed', processedAt: ctx.now() })
      .where(eq(inboundEvents.id, eventId)),
  );
}
