import { schema, withTenant } from '@waychat/db';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Ctx } from '../../../context.js';
import { assertCan, type Actor } from '../../authz/application/actor.js';

export interface AuditLogView {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  ip: string | null;
  createdAt: Date;
}

/** Paginação por cursor (`id` UUID v7 é ordenável por tempo): mais recentes primeiro, sem OFFSET. */
export async function listAuditLogs(
  ctx: Ctx,
  actor: Actor,
  opts: { limit: number; before?: string; action?: string },
): Promise<{ items: AuditLogView[]; nextCursor: string | null }> {
  assertCan(actor, 'audit:read');
  const limit = Math.min(Math.max(opts.limit, 1), 200);
  const rows = await withTenant(ctx.db, actor.accountId, (tx) =>
    tx
      .select({
        id: schema.auditLogs.id,
        actorUserId: schema.auditLogs.actorUserId,
        action: schema.auditLogs.action,
        targetType: schema.auditLogs.targetType,
        targetId: schema.auditLogs.targetId,
        metadata: schema.auditLogs.metadata,
        ip: schema.auditLogs.ip,
        createdAt: schema.auditLogs.createdAt,
      })
      .from(schema.auditLogs)
      .where(
        and(
          opts.before ? lt(schema.auditLogs.id, opts.before) : undefined,
          opts.action ? eq(schema.auditLogs.action, opts.action) : undefined,
        ),
      )
      .orderBy(desc(schema.auditLogs.id))
      .limit(limit + 1),
  );
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}
