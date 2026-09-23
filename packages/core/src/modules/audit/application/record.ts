import { schema, type Tx } from '@waychat/db';
import type { Db } from '@waychat/db';

export interface AuditEntry {
  /** Nulo para eventos sem conta (ex.: login com e-mail inexistente). Com conta, chamar dentro de `withTenant`. */
  accountId: string | null;
  actorUserId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Sem segredos, senhas nem conteúdo de mensagens. Identificadores de pessoa só como hash. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Grava em `audit_logs` (append-only). */
export async function recordAudit(tx: Tx | Db, entry: AuditEntry): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    accountId: entry.accountId,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
  });
}
