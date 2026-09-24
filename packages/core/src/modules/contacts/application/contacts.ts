import { schema, withTenant, type Tx } from '@waychat/db';
import { and, count, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../../context.js';
import { uniqueViolation } from '../../../db-errors.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';
import { enqueueEvent } from '../../events/application/enqueue.js';

const { contacts, contactIdentities, conversations } = schema;

const attributeValue = z.union([z.string().max(500), z.number(), z.boolean()]);

/** Telefone: mantém só `+` inicial e dígitos, 8 a 15 dígitos (E.164). Formatos como "(11) 90000-0000" são aceitos. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return `${raw.trim().startsWith('+') ? '+' : ''}${digits}`;
}

const contactFields = {
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)).nullable(),
  phone: z
    .string()
    .trim()
    .max(40)
    .transform((v, ctx) => {
      const n = normalizePhone(v);
      if (!n) ctx.addIssue({ code: 'custom', message: 'telefone inválido' });
      return n ?? '';
    })
    .nullable(),
  attributes: z
    .record(z.string().max(60), attributeValue)
    .refine((o) => Object.keys(o).length <= 20, 'no máximo 20 atributos'),
};

export const createContactInput = z.object({
  name: contactFields.name,
  email: contactFields.email.optional(),
  phone: contactFields.phone.optional(),
  attributes: contactFields.attributes.optional(),
});
export const updateContactInput = createContactInput.partial();

export interface ContactView {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  attributes: Record<string, string | number | boolean>;
  createdAt: Date;
  updatedAt: Date;
}

const toView = (r: typeof contacts.$inferSelect): ContactView => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  attributes: r.attributes as ContactView['attributes'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

function parse<T>(schemaObj: z.ZodType<T>, input: unknown): T {
  const r = schemaObj.safeParse(input);
  if (!r.success)
    throw new DomainError('invalid_input', r.error.issues.map((i) => i.path.join('.')).join(', '));
  return r.data;
}

export async function createContact(
  ctx: Ctx,
  actor: Actor,
  rawInput: unknown,
): Promise<ContactView> {
  assertCan(actor, 'contacts:manage');
  const input = parse(createContactInput, rawInput);
  return withTenant(ctx.db, actor.accountId, async (tx) => {
    const [row] = await tx
      .insert(contacts)
      .values({
        accountId: actor.accountId,
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        attributes: input.attributes ?? {},
      })
      .returning();
    if (!row) throw new Error('falha ao criar contato');
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'contact',
      aggregateId: row.id,
      type: 'contact.created',
      payload: { contact_id: row.id },
    });
    return toView(row);
  });
}

export async function getContact(ctx: Ctx, actor: Actor, contactId: string): Promise<ContactView> {
  assertCan(actor, 'contacts:read');
  const [row] = await withTenant(ctx.db, actor.accountId, (tx) =>
    tx.select().from(contacts).where(eq(contacts.id, contactId)).limit(1),
  );
  if (!row) throw new DomainError('not_found');
  return toView(row);
}

export async function updateContact(
  ctx: Ctx,
  actor: Actor,
  contactId: string,
  rawInput: unknown,
): Promise<ContactView> {
  assertCan(actor, 'contacts:manage');
  const input = parse(updateContactInput, rawInput);
  return withTenant(ctx.db, actor.accountId, async (tx) => {
    const [row] = await tx
      .update(contacts)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
      })
      .where(eq(contacts.id, contactId))
      .returning();
    if (!row) throw new DomainError('not_found');
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'contact',
      aggregateId: contactId,
      type: 'contact.updated',
      payload: { contact_id: contactId },
    });
    return toView(row);
  });
}

/** Só sem conversas (apagar levaria o histórico junto). Exclusão/anonimização por LGPD é da Fase 7. */
export async function deleteContact(ctx: Ctx, actor: Actor, contactId: string): Promise<void> {
  assertCan(actor, 'contacts:manage');
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    const [found] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    if (!found) throw new DomainError('not_found');
    const [used] = await tx
      .select({ n: count() })
      .from(conversations)
      .where(eq(conversations.contactId, contactId));
    if ((used?.n ?? 0) > 0) throw new DomainError('contact_in_use');
    await tx.delete(contacts).where(eq(contacts.id, contactId));
    await recordAudit(tx, {
      accountId: actor.accountId,
      actorUserId: actor.userId,
      action: 'contact.deleted',
      targetType: 'contact',
      targetId: contactId,
    });
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'contact',
      aggregateId: contactId,
      type: 'contact.deleted',
      payload: { contact_id: contactId },
    });
  });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Lista com busca parcial (nome, e-mail, telefone; aproveita os índices trigram) e paginação por cursor
 * (`id` UUID v7 é ordenável por tempo: mais recentes primeiro, sem OFFSET).
 */
export async function listContacts(
  ctx: Ctx,
  actor: Actor,
  opts: { search?: string; limit?: number; before?: string } = {},
): Promise<{ items: ContactView[]; nextCursor: string | null }> {
  assertCan(actor, 'contacts:read');
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const term = opts.search?.trim();
  const pattern = term ? `%${escapeLike(term)}%` : null;
  const digits = term?.replace(/[^\d]/g, '') ?? '';
  const rows = await withTenant(ctx.db, actor.accountId, (tx) =>
    tx
      .select()
      .from(contacts)
      .where(
        and(
          opts.before ? lt(contacts.id, opts.before) : undefined,
          pattern
            ? or(
                sql`${contacts.name} ILIKE ${pattern}`,
                sql`${contacts.email} ILIKE ${pattern}`,
                digits.length >= 3 ? sql`${contacts.phone} ILIKE ${`%${digits}%`}` : undefined,
              )
            : undefined,
        ),
      )
      .orderBy(desc(contacts.id))
      .limit(limit + 1),
  );
  const items = rows.slice(0, limit);
  return {
    items: items.map(toView),
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  };
}

/**
 * Encontra o contato dono de uma identidade de canal (ex.: id do visitante do widget, wa_id) ou o cria.
 * Idempotente e seguro sob concorrência: a unicidade `(conta, canal, external_id)` decide quem cria,
 * e quem perde a corrida lê o contato do vencedor. Roda dentro da transação do chamador.
 */
export async function findOrCreateContactByIdentity(
  tx: Tx,
  accountId: string,
  identity: {
    channel: string;
    externalId: string;
    name: string;
    email?: string | null;
    phone?: string | null;
  },
): Promise<{ contactId: string; created: boolean }> {
  const found = async () => {
    const [r] = await tx
      .select({ contactId: contactIdentities.contactId })
      .from(contactIdentities)
      .where(
        and(
          eq(contactIdentities.channel, identity.channel),
          eq(contactIdentities.externalId, identity.externalId),
        ),
      )
      .limit(1);
    return r?.contactId;
  };
  const existing = await found();
  if (existing) return { contactId: existing, created: false };

  // savepoint: uma violação de unicidade aqui não pode abortar a transação inteira do chamador
  try {
    return await tx.transaction(async (sp) => {
      const [contact] = await sp
        .insert(contacts)
        .values({
          accountId,
          name: identity.name,
          email: identity.email ?? null,
          phone: identity.phone ?? null,
        })
        .returning({ id: contacts.id });
      if (!contact) throw new Error('falha ao criar contato');
      await sp.insert(contactIdentities).values({
        accountId,
        contactId: contact.id,
        channel: identity.channel,
        externalId: identity.externalId,
      });
      return { contactId: contact.id, created: true };
    });
  } catch (e) {
    if (!uniqueViolation(e)) throw e;
    const winner = await found();
    if (!winner) throw e;
    return { contactId: winner, created: false };
  }
}
