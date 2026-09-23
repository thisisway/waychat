import { schema, withTenant } from '@waychat/db';
import { and, eq, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../../context.js';
import { uniqueViolation } from '../../../db-errors.js';
import { DomainError } from '../../../errors.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';
import { enqueueEvent } from '../../events/application/enqueue.js';
import { assertCanRead, loadVisibleConversation } from './access.js';

const { labels, conversationLabels, cannedResponses } = schema;

export interface LabelView {
  id: string;
  name: string;
  color: string;
}

const labelInput = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6a6e75'),
});

function parse<T>(schemaObj: z.ZodType<T>, input: unknown): T {
  const r = schemaObj.safeParse(input);
  if (!r.success)
    throw new DomainError('invalid_input', r.error.issues.map((i) => i.path.join('.')).join(', '));
  return r.data;
}

export async function listLabels(ctx: Ctx, actor: Actor): Promise<LabelView[]> {
  assertCanRead(actor);
  return withTenant(ctx.db, actor.accountId, (tx) =>
    tx
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(labels)
      .orderBy(labels.name),
  );
}

export async function createLabel(ctx: Ctx, actor: Actor, rawInput: unknown): Promise<LabelView> {
  assertCan(actor, 'labels:manage');
  const input = parse(labelInput, rawInput);
  try {
    const [row] = await withTenant(ctx.db, actor.accountId, (tx) =>
      tx
        .insert(labels)
        .values({ accountId: actor.accountId, name: input.name, color: input.color })
        .returning({ id: labels.id, name: labels.name, color: labels.color }),
    );
    if (!row) throw new Error('falha ao criar label');
    return row;
  } catch (e) {
    if (uniqueViolation(e)) throw new DomainError('name_taken');
    throw e;
  }
}

export async function deleteLabel(ctx: Ctx, actor: Actor, labelId: string): Promise<void> {
  assertCan(actor, 'labels:manage');
  const done = await withTenant(ctx.db, actor.accountId, (tx) =>
    tx.delete(labels).where(eq(labels.id, labelId)).returning({ id: labels.id }),
  );
  if (done.length === 0) throw new DomainError('not_found');
}

async function touch(
  ctx: Ctx,
  actor: Actor,
  conversationId: string,
  labelId: string,
  add: boolean,
): Promise<void> {
  assertCan(actor, 'conversations:manage');
  await withTenant(ctx.db, actor.accountId, async (tx) => {
    const conv = await loadVisibleConversation(tx, actor, conversationId);
    const [label] = await tx
      .select({ id: labels.id })
      .from(labels)
      .where(eq(labels.id, labelId))
      .limit(1);
    if (!label) throw new DomainError('not_found');
    const changed = add
      ? await tx
          .insert(conversationLabels)
          .values({ accountId: actor.accountId, conversationId, labelId })
          .onConflictDoNothing()
          .returning({ l: conversationLabels.labelId })
      : await tx
          .delete(conversationLabels)
          .where(
            and(
              eq(conversationLabels.conversationId, conversationId),
              eq(conversationLabels.labelId, labelId),
            ),
          )
          .returning({ l: conversationLabels.labelId });
    if (changed.length === 0) return; // idempotente: já estava assim
    await enqueueEvent(tx, {
      accountId: actor.accountId,
      aggregateType: 'conversation',
      aggregateId: conversationId,
      type: 'conversation.updated',
      payload: { conversation_id: conversationId, inbox_id: conv.inboxId, fields: ['labels'] },
    });
  });
}

export const addLabel = (ctx: Ctx, actor: Actor, conversationId: string, labelId: string) =>
  touch(ctx, actor, conversationId, labelId, true);
export const removeLabel = (ctx: Ctx, actor: Actor, conversationId: string, labelId: string) =>
  touch(ctx, actor, conversationId, labelId, false);

// ---------- respostas prontas ----------

export interface CannedResponseView {
  id: string;
  shortcut: string;
  content: string;
}

const cannedInput = z.object({
  shortcut: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{1,32}$/, 'use letras, números, - ou _ (até 32)'),
  content: z.string().trim().min(1).max(4000),
});

export async function listCannedResponses(
  ctx: Ctx,
  actor: Actor,
  search?: string,
): Promise<CannedResponseView[]> {
  assertCanRead(actor);
  const term = search?.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
  return withTenant(ctx.db, actor.accountId, (tx) =>
    tx
      .select({
        id: cannedResponses.id,
        shortcut: cannedResponses.shortcut,
        content: cannedResponses.content,
      })
      .from(cannedResponses)
      .where(
        term
          ? or(
              ilike(cannedResponses.shortcut, `${term}%`),
              ilike(cannedResponses.content, `%${term}%`),
            )
          : undefined,
      )
      .orderBy(cannedResponses.shortcut)
      .limit(50),
  );
}

export async function createCannedResponse(
  ctx: Ctx,
  actor: Actor,
  rawInput: unknown,
): Promise<CannedResponseView> {
  assertCan(actor, 'canned_responses:manage');
  const input = parse(cannedInput, rawInput);
  try {
    const [row] = await withTenant(ctx.db, actor.accountId, (tx) =>
      tx
        .insert(cannedResponses)
        .values({
          accountId: actor.accountId,
          shortcut: input.shortcut,
          content: input.content,
          createdBy: actor.userId,
        })
        .returning({
          id: cannedResponses.id,
          shortcut: cannedResponses.shortcut,
          content: cannedResponses.content,
        }),
    );
    if (!row) throw new Error('falha ao criar resposta pronta');
    return row;
  } catch (e) {
    if (uniqueViolation(e)) throw new DomainError('name_taken');
    throw e;
  }
}

export async function updateCannedResponse(
  ctx: Ctx,
  actor: Actor,
  id: string,
  rawInput: unknown,
): Promise<CannedResponseView> {
  assertCan(actor, 'canned_responses:manage');
  const input = parse(cannedInput.partial(), rawInput);
  try {
    const [row] = await withTenant(ctx.db, actor.accountId, (tx) =>
      tx
        .update(cannedResponses)
        .set({
          ...(input.shortcut !== undefined ? { shortcut: input.shortcut } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
        })
        .where(eq(cannedResponses.id, id))
        .returning({
          id: cannedResponses.id,
          shortcut: cannedResponses.shortcut,
          content: cannedResponses.content,
        }),
    );
    if (!row) throw new DomainError('not_found');
    return row;
  } catch (e) {
    if (uniqueViolation(e)) throw new DomainError('name_taken');
    throw e;
  }
}

export async function deleteCannedResponse(ctx: Ctx, actor: Actor, id: string): Promise<void> {
  assertCan(actor, 'canned_responses:manage');
  const done = await withTenant(ctx.db, actor.accountId, (tx) =>
    tx
      .delete(cannedResponses)
      .where(eq(cannedResponses.id, id))
      .returning({ id: cannedResponses.id }),
  );
  if (done.length === 0) throw new DomainError('not_found');
}
