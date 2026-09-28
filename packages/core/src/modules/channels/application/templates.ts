import { schema, withTenant } from '@waychat/db';
import { asc, eq } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';

const { messageTemplates } = schema;

/**
 * O que a Meta devolve (sincronização, criação ou webhook de status) — o núcleo não conhece o formato de
 * componente da Meta, só guarda e devolve `components` como veio (a pré-visualização é o painel quem lê).
 */
export interface RemoteTemplateData {
  providerTemplateId: string | null;
  name: string;
  language: string;
  /** Só o status normalizado do WayChat (`pending`, `approved`...): quem chama já traduziu o da Meta. */
  status: string;
  reason?: string | null;
  /** Ausente no webhook de status (só confirma status); a sincronização e a criação sempre informam. */
  category?: string;
  components?: unknown[];
}

export interface TemplateView {
  id: string;
  providerTemplateId: string | null;
  name: string;
  language: string;
  category: string;
  status: string;
  reason: string | null;
  components: unknown[];
  createdAt: Date;
  updatedAt: Date;
}

const toView = (row: typeof messageTemplates.$inferSelect): TemplateView => ({
  id: row.id,
  providerTemplateId: row.providerTemplateId,
  name: row.name,
  language: row.language,
  category: row.category,
  status: row.status,
  reason: row.reason,
  components: row.components as unknown[],
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Grava/atualiza um template pela chave `(inbox, name, language)` — a mesma constraint única da tabela.
 * Usada pela sincronização, pela criação (painel) e pelo webhook `message_template_status_update`; o webhook não
 * traz categoria nem componentes, então uma atualização só de status nunca apaga o que já foi sincronizado antes.
 */
export async function upsertTemplateFromMeta(
  ctx: Ctx,
  accountId: string,
  inboxId: string,
  remote: RemoteTemplateData,
): Promise<TemplateView> {
  const [row] = await withTenant(ctx.db, accountId, (tx) =>
    tx
      .insert(messageTemplates)
      .values({
        accountId,
        inboxId,
        providerTemplateId: remote.providerTemplateId,
        name: remote.name,
        language: remote.language,
        category: remote.category ?? 'UTILITY',
        status: remote.status,
        reason: remote.reason ?? null,
        components: remote.components ?? [],
      })
      .onConflictDoUpdate({
        target: [messageTemplates.inboxId, messageTemplates.name, messageTemplates.language],
        set: {
          providerTemplateId: remote.providerTemplateId,
          status: remote.status,
          reason: remote.reason ?? null,
          updatedAt: ctx.now(),
          ...(remote.category !== undefined ? { category: remote.category } : {}),
          ...(remote.components !== undefined ? { components: remote.components } : {}),
        },
      })
      .returning(),
  );
  if (!row) throw new Error('falha ao gravar o template');
  return toView(row);
}

/** Templates da inbox para a tela de canais/composer do painel. */
export async function listWhatsAppTemplates(
  ctx: Ctx,
  actor: Actor,
  inboxId: string,
): Promise<TemplateView[]> {
  assertCan(actor, 'inboxes:manage');
  const rows = await withTenant(ctx.db, actor.accountId, (tx) =>
    tx
      .select()
      .from(messageTemplates)
      .where(eq(messageTemplates.inboxId, inboxId))
      .orderBy(asc(messageTemplates.name), asc(messageTemplates.language)),
  );
  return rows.map(toView);
}
