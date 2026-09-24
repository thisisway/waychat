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
