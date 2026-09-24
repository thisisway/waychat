import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import type { ObjectStore, Scanner, ScanVerdict } from '@waychat/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreConfigFromEnv, createCtx, type Ctx } from './context.js';
import { DomainError, type DomainErrorCode } from './errors.js';
import {
  authenticate,
  completeUpload,
  createInbox,
  listMessages,
  login,
  receiveInboundMessage,
  registerAccount,
  requestUpload,
  scanAttachment,
  sendMessage,
  type Actor,
  type UploadSubject,
} from './index.js';

let t: TestDb;
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;
const PASSWORD = 'uma-senha-bem-longa-42';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const EXE = new TextEncoder().encode('MZ\x90\0\x03\0\0\0 programa');

/** Armazenamento em memória: o teste "faz o upload" gravando direto no mapa, no lugar do navegador. */
class MemStore implements ObjectStore {
  objects = new Map<string, Uint8Array>();
  presigned: string[] = [];
  presignUpload(key: string) {
    this.presigned.push(key);
    return Promise.resolve({ url: 'http://s3.test/bucket', fields: { key } });
  }
  head(key: string) {
    const o = this.objects.get(key);
    return Promise.resolve(o ? { size: o.length } : null);
  }
  readHead(key: string, bytes: number) {
    return Promise.resolve((this.objects.get(key) ?? new Uint8Array()).subarray(0, bytes));
  }
  stream(key: string) {
    return Promise.resolve(Readable.from([Buffer.from(this.objects.get(key) ?? [])]));
  }
  remove(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }
  presignDownload(key: string) {
    return Promise.resolve(`http://s3.test/${key}`);
  }
}

let verdict: ScanVerdict = { status: 'clean' };
const scanner: Scanner = { scan: () => Promise.resolve(verdict) };

const store = new MemStore();
const queued: { accountId: string; id: string }[] = [];
let ctx: Ctx; // com antivírus
let ctxNoScan: Ctx; // desenvolvimento: sem antivírus

async function expectCode(p: Promise<unknown>, code: DomainErrorCode) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}

beforeAll(async () => {
  t = await startTestDb();
  const cfg = coreConfigFromEnv({
    SESSION_SECRET: 'a'.repeat(48),
    MASTER_KEY: randomBytes(32).toString('base64'),
    MASTER_KEY_PREVIOUS: undefined,
  });
  const enqueueScan = (accountId: string, id: string) => {
    queued.push({ accountId, id });
    return Promise.resolve();
  };
  ctx = createCtx(t.app.db, cfg, undefined, { store, scanner, enqueueScan });
  ctxNoScan = createCtx(t.app.db, cfg, undefined, { store, scanner: null, enqueueScan });
});
afterAll(async () => {
  await t.stop();
});

async function setup() {
  const email = `dono-${uniq()}@exemplo.com`;
  const { accountId } = await registerAccount(ctx, {
    accountName: 'Acme',
    ownerName: 'Dono',
    email,
    password: PASSWORD,
  });
  const r = await login(ctx, { email, password: PASSWORD });
  if (r.status !== 'authenticated') throw new Error('esperava authenticated');
  const owner: Actor = await authenticate(ctx, r.tokens.accessToken);
  const inbox = (await createInbox(ctx, owner, { name: 'Site', channelType: 'widget' })).inbox;
  const other = (await createInbox(ctx, owner, { name: 'Outra', channelType: 'widget' })).inbox;
  const agent: UploadSubject = {
    accountId,
    inboxId: inbox.id,
    uploaderType: 'user',
    uploaderId: owner.userId,
  };
  const visitor: UploadSubject = {
    accountId,
    inboxId: inbox.id,
    uploaderType: 'visitor',
    uploaderId: 'anon:v1',
  };
  return { accountId, owner, inbox, other, agent, visitor };
}

/** Pede a URL, "envia" os bytes e conclui. */
async function upload(
  c: Ctx,
  s: UploadSubject,
  fileName: string,
  bytes: Uint8Array,
  declaredSize = bytes.length,
) {
  const { attachment } = await requestUpload(c, s, { fileName, size: declaredSize });
  const key = store.presigned.at(-1) ?? '';
  store.objects.set(key, bytes);
  return { id: attachment.id, key, complete: () => completeUpload(c, s, attachment.id) };
}

async function conversationOf(s: Awaited<ReturnType<typeof setup>>) {
  const r = await receiveInboundMessage(ctx, {
    accountId: s.accountId,
    inboxId: s.inbox.id,
    identity: { channel: 'widget', externalId: 'anon:v1', name: 'Visitante' },
    content: 'oi',
  });
  return r.conversationId;
}

describe('pedido de upload', () => {
  it('a chave do objeto é montada no servidor, sob o prefixo da conta', async () => {
    const s = await setup();
    const { attachment, upload: u } = await requestUpload(ctx, s.agent, {
      fileName: '../../../etc/relatório final.pdf',
      size: 1234,
    });
    expect(attachment).toMatchObject({
      fileName: 'relatório final.pdf',
      status: 'awaiting_upload',
    });
    expect(u.fields['key']).toBe(`accounts/${s.accountId}/${attachment.id}`);
  });

  it('recusa extensão fora da lista, tamanho zero, grande demais e nome vazio', async () => {
    const s = await setup();
    for (const input of [
      { fileName: 'virus.exe', size: 10 },
      { fileName: 'pagina.html', size: 10 },
      { fileName: 'a.pdf', size: 0 },
      { fileName: 'a.pdf', size: 10 * 1024 * 1024 + 1 },
      { fileName: '   ', size: 10 },
    ]) {
      await expectCode(requestUpload(ctx, s.agent, input), 'invalid_input');
    }
  });

  it('limita quantos uploads soltos cada remetente mantém', async () => {
    const s = await setup();
    for (let i = 0; i < 20; i++)
      await requestUpload(ctx, s.visitor, { fileName: `f${String(i)}.png`, size: 5 });
    await expectCode(requestUpload(ctx, s.visitor, { fileName: 'x.png', size: 5 }), 'rate_limited');
    // o limite é por remetente
    await requestUpload(ctx, s.agent, { fileName: 'x.png', size: 5 });
  });

  it('sem serviço de arquivos configurado, anexos ficam desligados', async () => {
    const s = await setup();
    const semArquivos = createCtx(t.app.db, ctx.config);
    await expectCode(
      requestUpload(semArquivos, s.agent, { fileName: 'a.png', size: 5 }),
      'invalid_input',
    );
  });
});

describe('conclusão do upload', () => {
  it('confere a assinatura e segue para a varredura', async () => {
    const s = await setup();
    const u = await upload(ctx, s.agent, 'foto.png', PNG);
    const done = await u.complete();
    expect(done).toMatchObject({ status: 'scanning', contentType: 'image/png', size: PNG.length });
    expect(queued.at(-1)).toEqual({ accountId: s.accountId, id: u.id });
  });

  it('sem antivírus (desenvolvimento) o arquivo já sai como limpo', async () => {
    const s = await setup();
    const u = await upload(ctxNoScan, s.agent, 'foto.png', PNG);
    expect((await u.complete()).status).toBe('clean');
  });

  it('o tamanho gravado é o real, não o declarado', async () => {
    const s = await setup();
    const u = await upload(ctx, s.agent, 'foto.png', PNG, 5);
    expect((await u.complete()).size).toBe(PNG.length);
  });

  it('executável disfarçado de PDF é recusado e o objeto é apagado', async () => {
    const s = await setup();
    const u = await upload(ctx, s.agent, 'fatura.pdf', EXE);
    await expectCode(u.complete(), 'invalid_input');
    expect(store.objects.has(u.key)).toBe(false);
    const row = await t.owner.pool.query(
      'select status, reject_reason from attachments where id = $1',
      [u.id],
    );
    expect(row.rows[0]).toEqual({ status: 'rejected', reject_reason: 'tipo' });
  });

  it('não conclui sem ter enviado, nem duas vezes, nem o anexo de outro remetente', async () => {
    const s = await setup();
    const { attachment } = await requestUpload(ctx, s.agent, { fileName: 'a.png', size: 5 });
    await expectCode(completeUpload(ctx, s.agent, attachment.id), 'invalid_input'); // não enviou
    store.objects.set(store.presigned.at(-1) ?? '', PNG);
    await expectCode(completeUpload(ctx, s.visitor, attachment.id), 'not_found'); // outro remetente
    await completeUpload(ctx, s.agent, attachment.id);
    await expectCode(completeUpload(ctx, s.agent, attachment.id), 'not_found'); // já concluído
  });

  it('remetente de outra conta não enxerga o anexo (RLS)', async () => {
    const a = await setup();
    const b = await setup();
    const u = await upload(ctx, a.agent, 'a.png', PNG);
    await expectCode(completeUpload(ctx, { ...b.agent, inboxId: a.inbox.id }, u.id), 'not_found');
  });
});

describe('varredura', () => {
  it('limpo → liberado', async () => {
    const s = await setup();
    const u = await upload(ctx, s.agent, 'a.png', PNG);
    await u.complete();
    verdict = { status: 'clean' };
    await scanAttachment(ctx, s.accountId, u.id);
    const row = await t.owner.pool.query('select status from attachments where id = $1', [u.id]);
    expect(row.rows[0].status).toBe('clean');
    await scanAttachment(ctx, s.accountId, u.id); // job repetido: nada acontece
  });

  it('infectado → apagado, marcado e auditado', async () => {
    const s = await setup();
    const u = await upload(ctx, s.agent, 'a.png', PNG);
    await u.complete();
    verdict = { status: 'infected', signature: 'Eicar-Test-Signature' };
    await scanAttachment(ctx, s.accountId, u.id);
    expect(store.objects.has(u.key)).toBe(false);
    const row = await t.owner.pool.query(
      'select status, reject_reason from attachments where id = $1',
      [u.id],
    );
    expect(row.rows[0]).toEqual({ status: 'infected', reject_reason: 'Eicar-Test-Signature' });
    const audit = await t.owner.pool.query(
      "select metadata from audit_logs where action = 'attachment.infected' and target_id = $1",
      [u.id],
    );
    expect(audit.rows[0].metadata).toEqual({ signature: 'Eicar-Test-Signature' });
    verdict = { status: 'clean' };
  });

  it('falha do antivírus NÃO libera: lança para o job repetir e o arquivo fica retido', async () => {
    const s = await setup();
    const u = await upload(ctx, s.agent, 'a.png', PNG);
    await u.complete();
    verdict = { status: 'error', reason: 'clamd fora do ar' };
    await expect(scanAttachment(ctx, s.accountId, u.id)).rejects.toThrow(/varredura/);
    const row = await t.owner.pool.query('select status from attachments where id = $1', [u.id]);
    expect(row.rows[0].status).toBe('scanning');
    verdict = { status: 'clean' };
  });
});

describe('anexos nas mensagens', () => {
  const clean = async (
    s: Awaited<ReturnType<typeof setup>>,
    subj: UploadSubject,
    name = 'a.png',
  ) => {
    const u = await upload(ctx, subj, name, PNG);
    await u.complete();
    verdict = { status: 'clean' };
    await scanAttachment(ctx, s.accountId, u.id);
    return u.id;
  };

  it('atendente envia foto sem texto; ela aparece no histórico', async () => {
    const s = await setup();
    const conversationId = await conversationOf(s);
    const id = await clean(s, s.agent, 'foto.png');
    const { message } = await sendMessage(ctx, s.owner, {
      conversationId,
      content: '',
      attachmentIds: [id],
      clientMessageId: crypto.randomUUID(),
    });
    expect(message.attachments).toMatchObject([
      { id, fileName: 'foto.png', contentType: 'image/png', status: 'clean' },
    ]);
    const list = await listMessages(ctx, s.owner, conversationId);
    expect(list.items[0]?.attachments.map((a) => a.id)).toEqual([id]);
  });

  it('mensagem sem texto e sem anexo é recusada', async () => {
    const s = await setup();
    const conversationId = await conversationOf(s);
    await expectCode(
      sendMessage(ctx, s.owner, {
        conversationId,
        content: '  ',
        clientMessageId: crypto.randomUUID(),
      }),
      'invalid_input',
    );
  });

  it('só anexos limpos, do próprio remetente, da mesma inbox e ainda não usados', async () => {
    const s = await setup();
    const conversationId = await conversationOf(s);
    const send = (ids: string[]) =>
      sendMessage(ctx, s.owner, {
        conversationId,
        content: 'x',
        attachmentIds: ids,
        clientMessageId: crypto.randomUUID(),
      });

    // ainda em varredura
    const pending = await upload(ctx, s.agent, 'a.png', PNG);
    await pending.complete();
    await expectCode(send([pending.id]), 'invalid_input');
    // de outro remetente (o visitante) — o atendente não pode "roubar" o arquivo dele
    const deVisitante = await clean(s, s.visitor);
    await expectCode(send([deVisitante]), 'invalid_input');
    // de outra inbox
    const deOutraInbox = await clean(s, { ...s.agent, inboxId: s.other.id });
    await expectCode(send([deOutraInbox]), 'invalid_input');
    // inexistente
    await expectCode(send([crypto.randomUUID()]), 'invalid_input');
    // já usado
    const ok = await clean(s, s.agent);
    await send([ok]);
    await expectCode(send([ok]), 'invalid_input');
    // e nada disso deixou anexo pela metade: o pendente continua livre
    const row = await t.owner.pool.query('select message_id from attachments where id = $1', [
      pending.id,
    ]);
    expect(row.rows[0].message_id).toBeNull();
  });

  it('no máximo 5 anexos por mensagem', async () => {
    const s = await setup();
    const conversationId = await conversationOf(s);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await clean(s, s.agent));
    await expectCode(
      sendMessage(ctx, s.owner, {
        conversationId,
        content: 'x',
        attachmentIds: ids,
        clientMessageId: crypto.randomUUID(),
      }),
      'invalid_input',
    );
  });

  it('visitante envia o próprio arquivo; o de outro visitante não vale', async () => {
    const s = await setup();
    const id = await clean(s, s.visitor, 'comprovante.png');
    const outro: UploadSubject = { ...s.visitor, uploaderId: 'anon:v2' };
    const doOutro = await clean(s, outro);
    const base = {
      accountId: s.accountId,
      inboxId: s.inbox.id,
      identity: { channel: 'widget', externalId: 'anon:v1', name: 'V1' },
      content: '',
    };
    await expectCode(
      receiveInboundMessage(ctx, { ...base, attachmentIds: [doOutro] }),
      'invalid_input',
    );
    const r = await receiveInboundMessage(ctx, { ...base, attachmentIds: [id] });
    expect(r.message.attachments.map((a) => a.fileName)).toEqual(['comprovante.png']);
    // sem texto e sem anexo continua inválido
    await expectCode(receiveInboundMessage(ctx, { ...base }), 'invalid_input');
  });

  it('anexo que depois se revelou infectado deixa de aparecer', async () => {
    const s = await setup();
    const conversationId = await conversationOf(s);
    const id = await clean(s, s.agent);
    await sendMessage(ctx, s.owner, {
      conversationId,
      content: 'veja',
      attachmentIds: [id],
      clientMessageId: crypto.randomUUID(),
    });
    await t.owner.pool.query("update attachments set status = 'infected' where id = $1", [id]);
    const list = await listMessages(ctx, s.owner, conversationId);
    expect(list.items[0]?.attachments).toEqual([]);
  });
});
