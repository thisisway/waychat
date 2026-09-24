import { schema, withTenant, type Tx } from '@waychat/db';
import {
  detectContentType,
  extensionAllowed,
  MAX_ATTACHMENT_BYTES,
  sanitizeFileName,
} from '@waychat/storage';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../../context.js';
import { DomainError } from '../../../errors.js';
import { recordAudit } from '../../audit/application/record.js';

const { attachments } = schema;

/** Quantos anexos cabem numa mensagem. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
/** Quantos uploads soltos (ainda sem mensagem) cada remetente pode manter: freia quem só enche o bucket. */
const MAX_UNSENT_PER_UPLOADER = 20;
const HEAD_BYTES = 4096;

/** Quem envia o arquivo: um atendente (`users.id`) ou um visitante do widget (identidade do contato). */
export interface UploadSubject {
  accountId: string;
  inboxId: string;
  uploaderType: 'user' | 'visitor';
  uploaderId: string;
}

export interface AttachmentView {
  id: string;
  fileName: string;
  contentType: string | null;
  size: number;
  status: 'awaiting_upload' | 'scanning' | 'clean' | 'infected' | 'rejected';
}

export const toAttachmentView = (r: typeof attachments.$inferSelect): AttachmentView => ({
  id: r.id,
  fileName: r.fileName,
  contentType: r.contentType,
  size: r.sizeBytes,
  status: r.status as AttachmentView['status'],
});

function files(ctx: Ctx) {
  if (!ctx.files) throw new DomainError('invalid_input', 'anexos não estão habilitados');
  return ctx.files;
}

export const requestUploadInput = z.object({
  fileName: z.string().trim().min(1).max(255),
  size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
});

/** Quem enviou (e, se informada, a inbox). Concluir/consultar um upload não precisa saber a inbox: ela já está na linha. */
type Owner = Pick<UploadSubject, 'accountId' | 'uploaderType' | 'uploaderId'> & {
  inboxId?: string;
};
const ownedBy = (s: Owner) =>
  and(
    s.inboxId ? eq(attachments.inboxId, s.inboxId) : undefined,
    eq(attachments.uploaderType, s.uploaderType),
    eq(attachments.uploaderId, s.uploaderId),
  );

/** Passo 1: registra o anexo e devolve o formulário assinado para o navegador enviar direto ao S3. */
export async function requestUpload(
  ctx: Ctx,
  subject: UploadSubject,
  rawInput: unknown,
): Promise<{
  attachment: AttachmentView;
  upload: { url: string; fields: Record<string, string> };
}> {
  const { store } = files(ctx);
  const parsed = requestUploadInput.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('invalid_input', 'arquivo inválido ou grande demais');
  const fileName = sanitizeFileName(parsed.data.fileName);
  if (!extensionAllowed(fileName))
    throw new DomainError('invalid_input', 'tipo de arquivo não permitido');

  const row = await withTenant(ctx.db, subject.accountId, async (tx) => {
    const [pending] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attachments)
      .where(
        and(
          ownedBy(subject),
          isNull(attachments.messageId),
          sql`${attachments.status} <> 'rejected'`,
        ),
      );
    if ((pending?.n ?? 0) >= MAX_UNSENT_PER_UPLOADER)
      throw new DomainError('rate_limited', 'muitos arquivos aguardando envio');
    const id = crypto.randomUUID();
    const [created] = await tx
      .insert(attachments)
      .values({
        id,
        accountId: subject.accountId,
        inboxId: subject.inboxId,
        uploaderType: subject.uploaderType,
        uploaderId: subject.uploaderId,
        fileName,
        sizeBytes: parsed.data.size,
        // a chave é montada aqui: nada do que o cliente manda entra no caminho do objeto
        storageKey: `accounts/${subject.accountId}/${id}`,
      })
      .returning();
    if (!created) throw new Error('falha ao registrar anexo');
    return created;
  });
  const upload = await store.presignUpload(row.storageKey, { maxBytes: MAX_ATTACHMENT_BYTES });
  return { attachment: toAttachmentView(row), upload };
}

async function reject(
  ctx: Ctx,
  accountId: string,
  row: typeof attachments.$inferSelect,
  reason: string,
) {
  await withTenant(ctx.db, accountId, (tx) =>
    tx
      .update(attachments)
      .set({ status: 'rejected', rejectReason: reason, updatedAt: ctx.now() })
      .where(eq(attachments.id, row.id)),
  );
  await files(ctx)
    .store.remove(row.storageKey)
    .catch(() => undefined);
}

/**
 * Passo 2: o navegador avisa que enviou. Confere que o objeto existe, o tamanho real e a ASSINATURA do arquivo
 * (o nome/Content-Type declarados não valem nada). Passando, segue para a varredura antes de ser entregue.
 */
export async function completeUpload(
  ctx: Ctx,
  subject: Owner,
  attachmentId: string,
): Promise<AttachmentView> {
  const { store, scanner, enqueueScan } = files(ctx);
  const row = await withTenant(ctx.db, subject.accountId, async (tx) => {
    const [r] = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), ownedBy(subject)))
      .limit(1);
    return r;
  });
  if (row?.status !== 'awaiting_upload') throw new DomainError('not_found');

  const head = await store.head(row.storageKey);
  if (!head) throw new DomainError('invalid_input', 'o arquivo ainda não foi enviado');
  if (head.size < 1 || head.size > MAX_ATTACHMENT_BYTES) {
    await reject(ctx, subject.accountId, row, 'tamanho');
    throw new DomainError('invalid_input', 'tamanho de arquivo não permitido');
  }
  const contentType = detectContentType(
    await store.readHead(row.storageKey, HEAD_BYTES),
    row.fileName,
  );
  if (!contentType) {
    await reject(ctx, subject.accountId, row, 'tipo');
    throw new DomainError(
      'invalid_input',
      'o conteúdo do arquivo não corresponde ao tipo permitido',
    );
  }

  // sem antivírus configurado (só desenvolvimento) o arquivo vale como limpo; a API se recusa a subir assim em produção
  const status = scanner ? 'scanning' : 'clean';
  const updated = await withTenant(ctx.db, subject.accountId, async (tx) => {
    const [u] = await tx
      .update(attachments)
      .set({ status, contentType, sizeBytes: head.size, updatedAt: ctx.now() })
      .where(and(eq(attachments.id, row.id), eq(attachments.status, 'awaiting_upload')))
      .returning();
    return u;
  });
  if (!updated) throw new DomainError('not_found'); // outra chamada concluiu primeiro
  if (status === 'scanning') await enqueueScan(subject.accountId, row.id);
  return toAttachmentView(updated);
}

/**
 * Executada pelo worker. Limpo → libera; infectado → apaga o objeto e registra; falha do antivírus → lança
 * (o BullMQ repete com backoff) e o arquivo continua retido em `scanning`.
 */
export async function scanAttachment(
  ctx: Ctx,
  accountId: string,
  attachmentId: string,
): Promise<void> {
  const { store, scanner } = files(ctx);
  if (!scanner) return;
  const row = await withTenant(ctx.db, accountId, async (tx) => {
    const [r] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    return r;
  });
  if (row?.status !== 'scanning') return; // já resolvido (job repetido) ou apagado

  const verdict = await scanner.scan(await store.stream(row.storageKey));
  if (verdict.status === 'error') throw new Error(`falha na varredura: ${verdict.reason}`);

  await withTenant(ctx.db, accountId, async (tx) => {
    await tx
      .update(attachments)
      .set({
        status: verdict.status === 'clean' ? 'clean' : 'infected',
        rejectReason: verdict.status === 'infected' ? verdict.signature : null,
        updatedAt: ctx.now(),
      })
      .where(and(eq(attachments.id, row.id), eq(attachments.status, 'scanning')));
    if (verdict.status === 'infected') {
      await recordAudit(tx, {
        accountId,
        actorUserId: null,
        action: 'attachment.infected',
        targetType: 'attachment',
        targetId: row.id,
        metadata: { signature: verdict.signature },
      });
    }
  });
  if (verdict.status === 'infected') await store.remove(row.storageKey);
}

export async function getOwnAttachment(
  ctx: Ctx,
  subject: Owner,
  attachmentId: string,
): Promise<AttachmentView> {
  const row = await withTenant(ctx.db, subject.accountId, async (tx) => {
    const [r] = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), ownedBy(subject)))
      .limit(1);
    return r;
  });
  if (!row) throw new DomainError('not_found');
  return toAttachmentView(row);
}

/**
 * Amarra anexos a uma mensagem recém-criada (dentro da transação que a cria). Cada um precisa ser do MESMO remetente,
 * da mesma inbox, estar limpo e ainda sem mensagem. Qualquer outra coisa → erro genérico (não revela de quem é).
 */
export async function claimAttachments(
  tx: Tx,
  subject: UploadSubject,
  messageId: string,
  ids: readonly string[],
): Promise<AttachmentView[]> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  if (unique.length > MAX_ATTACHMENTS_PER_MESSAGE)
    throw new DomainError('invalid_input', 'anexos demais na mensagem');
  const claimed = await tx
    .update(attachments)
    .set({ messageId, updatedAt: new Date() })
    .where(
      and(
        inArray(attachments.id, unique),
        ownedBy(subject),
        eq(attachments.status, 'clean'),
        isNull(attachments.messageId),
      ),
    )
    .returning();
  if (claimed.length !== unique.length) throw new DomainError('invalid_input', 'anexo inválido');
  return claimed.map(toAttachmentView);
}

/** Anexos de várias mensagens de uma vez (sem N+1). Só os `clean` aparecem para o outro lado. */
export async function attachmentsByMessage(
  tx: Tx,
  messageIds: readonly string[],
): Promise<Map<string, AttachmentView[]>> {
  const out = new Map<string, AttachmentView[]>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(attachments)
    .where(and(inArray(attachments.messageId, [...messageIds]), eq(attachments.status, 'clean')))
    .orderBy(attachments.createdAt);
  for (const r of rows) {
    if (!r.messageId) continue;
    out.set(r.messageId, [...(out.get(r.messageId) ?? []), toAttachmentView(r)]);
  }
  return out;
}

/** Link de download de 5 minutos. Quem chama já provou que pode ver o anexo (mensagem/conversa); aqui só gera. */
export async function downloadUrlFor(
  ctx: Ctx,
  row: Pick<typeof attachments.$inferSelect, 'storageKey' | 'fileName' | 'contentType' | 'status'>,
): Promise<string> {
  if (row.status !== 'clean' || !row.contentType) throw new DomainError('not_found');
  return files(ctx).store.presignDownload(row.storageKey, {
    fileName: row.fileName,
    contentType: row.contentType,
  });
}
