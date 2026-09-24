import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@waychat/shared';
import { createDb, type DbHandle } from './client.js';
import { schema, withApiKeyPrefix, withInboxPublicKey, withTenant } from './index.js';
import { startTestDb, type TestDb } from './test-db.js';

const {
  accounts,
  inboxes,
  contacts,
  conversations,
  messages,
  outbox,
  labels,
  cannedResponses,
  apiKeys,
} = schema;

let t: TestDb;
let pool: DbHandle; // 10 conexões da role da aplicação: concorrência real
const A = uuidv7();
const B = uuidv7();

/** Drizzle embrulha o erro do Postgres em `cause`: confere a mensagem original. */
async function expectPgError(p: PromiseLike<unknown>, pattern: RegExp) {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'era esperado um erro').toBeDefined();
  const e = err as { message: string; cause?: { message?: string } };
  expect(`${e.message} ${e.cause?.message ?? ''}`).toMatch(pattern);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function seedChat(accountId: string, tag: string) {
  return withTenant(pool.db, accountId, async (tx) => {
    const [inbox] = await tx
      .insert(inboxes)
      .values({ accountId, name: `inbox-${tag}`, channelType: 'widget', publicKey: `pk_${tag}` })
      .returning();
    const [contact] = await tx
      .insert(contacts)
      .values({ accountId, name: `Contato ${tag}` })
      .returning();
    const [conv] = await tx
      .insert(conversations)
      .values({ accountId, inboxId: inbox!.id, contactId: contact!.id })
      .returning();
    const [msg] = await tx
      .insert(messages)
      .values({
        accountId,
        conversationId: conv!.id,
        inboxId: inbox!.id,
        direction: 'in',
        senderType: 'contact',
        content: `oi ${tag}`,
      })
      .returning();
    await tx.insert(labels).values({ accountId, name: `vip-${tag}` });
    await tx.insert(cannedResponses).values({ accountId, shortcut: `ola-${tag}`, content: 'Olá!' });
    return { inbox: inbox!, contact: contact!, conv: conv!, msg: msg! };
  });
}

let seedA: Awaited<ReturnType<typeof seedChat>>;
let seedB: Awaited<ReturnType<typeof seedChat>>;

beforeAll(async () => {
  t = await startTestDb();
  pool = createDb(t.urls.app, { max: 10 });
  await t.owner.db.insert(accounts).values([
    { id: A, name: 'A', slug: 'a' },
    { id: B, name: 'B', slug: 'b' },
  ]);
  seedA = await seedChat(A, 'a');
  seedB = await seedChat(B, 'b');
});

afterAll(async () => {
  await pool.close();
  await t.stop();
});

const event = (accountId: string) => ({
  accountId,
  aggregateType: 'test',
  aggregateId: uuidv7(),
  eventType: 'member.removed',
  payload: { user_id: uuidv7() },
});

describe('cursor de eventos por conta, sem lacunas (ADR 0006)', () => {
  it('30 transações concorrentes na mesma conta numeram 1..N sem repetir nem pular', async () => {
    const acc = uuidv7();
    await t.owner.db.insert(accounts).values({ id: acc, name: 'C', slug: `c-${acc.slice(-6)}` });
    await Promise.all(
      Array.from({ length: 30 }, () =>
        withTenant(pool.db, acc, async (tx) => {
          await tx.insert(outbox).values([event(acc), event(acc), event(acc)]);
          await sleep(Math.random() * 20);
        }),
      ),
    );
    const rows = await t.owner.pool.query<{ account_seq: string }>(
      'select account_seq from outbox where account_id = $1 order by account_seq',
      [acc],
    );
    expect(rows.rows.map((r) => Number(r.account_seq))).toEqual(
      Array.from({ length: 90 }, (_, i) => i + 1),
    );
  });

  it('ROLLBACK não deixa buraco: o número volta', async () => {
    const acc = uuidv7();
    await t.owner.db.insert(accounts).values({ id: acc, name: 'D', slug: `d-${acc.slice(-6)}` });
    await withTenant(pool.db, acc, (tx) => tx.insert(outbox).values(event(acc)));
    await expect(
      withTenant(pool.db, acc, async (tx) => {
        await tx.insert(outbox).values([event(acc), event(acc)]);
        throw new Error('falhou depois de numerar');
      }),
    ).rejects.toThrow();
    await withTenant(pool.db, acc, (tx) => tx.insert(outbox).values(event(acc)));
    const rows = await t.owner.pool.query(
      'select account_seq from outbox where account_id = $1 order by 1',
      [acc],
    );
    expect(rows.rows.map((r) => Number(r.account_seq))).toEqual([1, 2]);
  });

  it('ordem de commit = ordem do cursor: a transação rápida espera a lenta', async () => {
    const acc = uuidv7();
    await t.owner.db.insert(accounts).values({ id: acc, name: 'E', slug: `e-${acc.slice(-6)}` });
    const commits: string[] = [];
    // Sincronização por sinais (nada de "dorme X ms e torce"): a rápida só começa depois que a lenta já numerou,
    // e a lenta só confirma depois de a rápida ter sido disparada e ter tido tempo de bater no lock do contador.
    let slowHasSeq!: () => void;
    const slowInserted = new Promise<void>((r) => (slowHasSeq = r));
    let fastStarted!: () => void;
    const fastLaunched = new Promise<void>((r) => (fastStarted = r));

    const slow = withTenant(pool.db, acc, async (tx) => {
      await tx.insert(outbox).values(event(acc)); // número 1: segura o lock do contador
      slowHasSeq();
      await fastLaunched;
      await sleep(300); // dá tempo de a rápida chegar ao lock
    }).then(() => commits.push('lenta'));

    await slowInserted;
    fastStarted();
    const start = Date.now();
    const waited = await withTenant(pool.db, acc, (tx) =>
      tx.insert(outbox).values(event(acc)),
    ).then(() => {
      commits.push('rapida');
      return Date.now() - start;
    });
    await slow;
    expect(commits).toEqual(['lenta', 'rapida']);
    expect(waited).toBeGreaterThan(150); // ficou bloqueada até a lenta confirmar
    const rows = await t.owner.pool.query(
      'select account_seq from outbox where account_id = $1 order by account_seq',
      [acc],
    );
    expect(rows.rows.map((r) => Number(r.account_seq))).toEqual([1, 2]);
  });

  it('contas diferentes não se bloqueiam nem se misturam', async () => {
    const a = uuidv7();
    const b = uuidv7();
    await t.owner.db.insert(accounts).values([
      { id: a, name: 'F', slug: `f-${a.slice(-6)}` },
      { id: b, name: 'G', slug: `g-${b.slice(-6)}` },
    ]);
    // Se B dependesse do lock de A, os dois esperariam um pelo outro: A só confirma DEPOIS de B terminar.
    // Um deadlock aparece como timeout (5 s), sem depender de milissegundos.
    let aHasSeq!: () => void;
    const aInserted = new Promise<void>((r) => (aHasSeq = r));
    let bFinished!: () => void;
    const bDone = new Promise<void>((r) => (bFinished = r));
    const guard = <T>(p: Promise<T>) =>
      Promise.race([
        p,
        sleep(5000).then(() => Promise.reject(new Error('deadlock entre contas diferentes'))),
      ]);

    const held = withTenant(pool.db, a, async (tx) => {
      await tx.insert(outbox).values(event(a));
      aHasSeq();
      await guard(bDone);
    });
    await aInserted;
    await guard(withTenant(pool.db, b, (tx) => tx.insert(outbox).values(event(b))));
    bFinished();
    await held;
    const rows = await t.owner.pool.query(
      'select account_id, account_seq from outbox where account_id = any($1)',
      [[a, b]],
    );
    expect(rows.rows.every((r) => Number(r.account_seq) === 1)).toBe(true);
  });

  it('display_id das conversas é sequencial por conta', async () => {
    const acc = uuidv7();
    await t.owner.db.insert(accounts).values({ id: acc, name: 'H', slug: `h-${acc.slice(-6)}` });
    const s = await seedChat(acc, `h${acc.slice(-4)}`);
    await Promise.all(
      Array.from({ length: 9 }, () =>
        withTenant(pool.db, acc, (tx) =>
          tx
            .insert(conversations)
            .values({ accountId: acc, inboxId: s.inbox.id, contactId: s.contact.id }),
        ),
      ),
    );
    const rows = await withTenant(pool.db, acc, (tx) =>
      tx.select({ d: conversations.displayId }).from(conversations),
    );
    expect(rows.map((r) => r.d).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
    // a conta A tem a numeração dela, independente
    expect(seedA.conv.displayId).toBe(1);
    expect(seedB.conv.displayId).toBe(1);
  });
});

describe('isolamento das tabelas de atendimento', () => {
  it('cada tenant só enxerga as próprias linhas', async () => {
    const view = await withTenant(pool.db, A, async (tx) => ({
      inboxes: await tx.select().from(inboxes),
      contacts: await tx.select().from(contacts),
      conversations: await tx.select().from(conversations),
      messages: await tx.select().from(messages),
      labels: await tx.select().from(labels),
      canned: await tx.select().from(cannedResponses),
    }));
    for (const rows of Object.values(view)) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.accountId === A)).toBe(true);
    }
  });

  it('sem tenant nada aparece e escrever em outro tenant falha', async () => {
    expect(await pool.db.select().from(messages)).toHaveLength(0);
    await expect(
      withTenant(pool.db, A, (tx) => tx.insert(contacts).values({ accountId: B, name: 'invasor' })),
    ).rejects.toThrow();
  });

  it('mensagem só entra em conversa da mesma conta e da mesma inbox (trigger)', async () => {
    // conversa da conta B usada por uma mensagem da conta A: invisível pela RLS, o trigger nem a encontra
    await expectPgError(
      withTenant(pool.db, A, (tx) =>
        tx.insert(messages).values({
          accountId: A,
          conversationId: seedB.conv.id,
          inboxId: seedA.inbox.id,
          direction: 'in',
          senderType: 'contact',
          content: 'x',
        }),
      ),
      /inconsistente/,
    );
    // mesma conta, mas inbox diferente da conversa
    const [other] = await withTenant(pool.db, A, (tx) =>
      tx
        .insert(inboxes)
        .values({ accountId: A, name: 'segunda', channelType: 'api', publicKey: 'pk_a2' })
        .returning(),
    );
    await expectPgError(
      withTenant(pool.db, A, (tx) =>
        tx.insert(messages).values({
          accountId: A,
          conversationId: seedA.conv.id,
          inboxId: other!.id,
          direction: 'in',
          senderType: 'contact',
          content: 'x',
        }),
      ),
      /inconsistente/,
    );
  });
});

describe('idempotência e restrições', () => {
  const base = () => ({
    accountId: A,
    conversationId: seedA.conv.id,
    inboxId: seedA.inbox.id,
    direction: 'out' as const,
    senderType: 'user' as const,
    content: 'olá',
  });

  it('client_message_id repetido na mesma conta é recusado; em outra conta é livre', async () => {
    const cid = uuidv7();
    await withTenant(pool.db, A, (tx) =>
      tx.insert(messages).values({ ...base(), clientMessageId: cid }),
    );
    await expect(
      withTenant(pool.db, A, (tx) =>
        tx.insert(messages).values({ ...base(), clientMessageId: cid }),
      ),
    ).rejects.toThrow();
    await withTenant(pool.db, B, (tx) =>
      tx.insert(messages).values({
        accountId: B,
        conversationId: seedB.conv.id,
        inboxId: seedB.inbox.id,
        direction: 'out',
        senderType: 'user',
        content: 'olá',
        clientMessageId: cid,
      }),
    );
  });

  it('source_id repetido na mesma inbox é recusado', async () => {
    await withTenant(pool.db, A, (tx) =>
      tx.insert(messages).values({ ...base(), sourceId: 'wamid.1' }),
    );
    await expect(
      withTenant(pool.db, A, (tx) =>
        tx.insert(messages).values({ ...base(), sourceId: 'wamid.1' }),
      ),
    ).rejects.toThrow();
  });

  it('status e direção fora do domínio são recusados pelo banco', async () => {
    await expect(
      withTenant(pool.db, A, (tx) =>
        tx.execute(sql`update conversations set status = 'inventado' where id = ${seedA.conv.id}`),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(pool.db, A, (tx) =>
        tx.insert(messages).values({ ...base(), direction: 'lado' as never }),
      ),
    ).rejects.toThrow();
  });
});

describe('leitura por chave pública antes de existir tenant', () => {
  it('a chave da inbox devolve só essa inbox, de qualquer tenant, e só para leitura', async () => {
    const found = await withInboxPublicKey(pool.db, 'pk_b', (tx) => tx.select().from(inboxes));
    expect(found.map((i) => i.id)).toEqual([seedB.inbox.id]);
    const none = await withInboxPublicKey(pool.db, 'pk_nao_existe', (tx) =>
      tx.select().from(inboxes),
    );
    expect(none).toHaveLength(0);
    // a GUC não abre nenhuma outra tabela...
    const leaked = await withInboxPublicKey(pool.db, 'pk_b', (tx) => tx.select().from(contacts));
    expect(leaked).toHaveLength(0);
    // ...e não permite escrever
    const upd = await withInboxPublicKey(pool.db, 'pk_b', (tx) =>
      tx
        .update(inboxes)
        .set({ name: 'hack' })
        .where(sql`${inboxes.publicKey} = 'pk_b'`)
        .returning(),
    );
    expect(upd).toHaveLength(0);
  });

  it('o prefixo da chave de API devolve só aquela chave', async () => {
    for (const [acc, prefix] of [
      [A, 'wc_aaaa'],
      [B, 'wc_bbbb'],
    ] as const) {
      await withTenant(pool.db, acc, (tx) =>
        tx
          .insert(apiKeys)
          .values({ accountId: acc, name: 'k', keyPrefix: prefix, keyHash: 'hash' }),
      );
    }
    const k = await withApiKeyPrefix(pool.db, 'wc_bbbb', (tx) => tx.select().from(apiKeys));
    expect(k.map((r) => r.accountId)).toEqual([B]);
    expect(
      await withApiKeyPrefix(pool.db, 'wc_zzzz', (tx) => tx.select().from(apiKeys)),
    ).toHaveLength(0);
    expect(await pool.db.select().from(apiKeys)).toHaveLength(0); // sem GUC e sem tenant: nada
  });
});

describe('tabelas do canal WhatsApp', () => {
  const { messageTemplates, contactOptOuts } = schema;

  async function seedChannel(accountId: string, tag: string) {
    const { inbox, contact } = await seedChat(accountId, `wa-${tag}`);
    await withTenant(pool.db, accountId, async (tx) => {
      await tx.insert(messageTemplates).values({
        accountId,
        inboxId: inbox.id,
        name: `confirmacao_${tag}`,
        language: 'pt_BR',
        status: 'approved',
      });
      await tx
        .insert(contactOptOuts)
        .values({ accountId, contactId: contact.id, channel: 'whatsapp', keyword: 'SAIR' });
    });
    return { inbox, contact };
  }

  it('templates e opt-outs são isolados por conta', async () => {
    const a = await seedChannel(A, 'a');
    await seedChannel(B, 'b');
    const view = await withTenant(pool.db, A, async (tx) => ({
      templates: await tx.select().from(messageTemplates),
      optOuts: await tx.select().from(contactOptOuts),
    }));
    expect(view.templates.length).toBeGreaterThan(0);
    for (const rows of Object.values(view)) expect(rows.every((r) => r.accountId === A)).toBe(true);
    // escrever para outra conta falha
    await expect(
      withTenant(pool.db, A, (tx) =>
        tx.insert(messageTemplates).values({
          accountId: B,
          inboxId: a.inbox.id,
          name: 'invasor',
          language: 'pt_BR',
        }),
      ),
    ).rejects.toThrow();
  });

  it('o mesmo template (nome + idioma) não se repete na inbox; outro idioma pode', async () => {
    const { inbox } = await seedChannel(A, 'dup');
    const add = (language: string) =>
      withTenant(pool.db, A, (tx) =>
        tx
          .insert(messageTemplates)
          .values({ accountId: A, inboxId: inbox.id, name: 'confirmacao_dup', language }),
      );
    await expectPgError(add('pt_BR'), /message_templates_inbox_name_lang_uq|duplicate/i);
    await add('en_US');
  });

  it('opt-out é único por contato e canal', async () => {
    const { contact } = await seedChannel(A, 'oo');
    await expectPgError(
      withTenant(pool.db, A, (tx) =>
        tx
          .insert(contactOptOuts)
          .values({ accountId: A, contactId: contact.id, channel: 'whatsapp', keyword: 'PARAR' }),
      ),
      /contact_opt_outs_uq|duplicate/i,
    );
  });

  it('a mensagem aceita o estado "sending" e o banco recusa estados inventados', async () => {
    const seed = await seedChat(A, 'send');
    const insert = (status: string) =>
      withTenant(pool.db, A, (tx) =>
        tx.insert(messages).values({
          accountId: A,
          conversationId: seed.conv.id,
          inboxId: seed.inbox.id,
          direction: 'out',
          senderType: 'user',
          content: 'oi',
          status,
        }),
      );
    await insert('sending');
    await expect(insert('enviando')).rejects.toThrow();
  });

  it('inbox aceita o canal whatsapp; anexo aceita remetente "contact"', async () => {
    const seed = await seedChat(A, 'chan');
    await withTenant(pool.db, A, async (tx) => {
      await tx
        .insert(inboxes)
        .values({ accountId: A, name: 'zap', channelType: 'whatsapp', publicKey: 'pk_zap_chan' });
      await tx.insert(schema.attachments).values({
        accountId: A,
        inboxId: seed.inbox.id,
        uploaderType: 'contact',
        uploaderId: seed.contact.id,
        fileName: 'foto.jpg',
        sizeBytes: 10,
        storageKey: `accounts/${A}/${uuidv7()}`,
      });
    });
    await expect(
      withTenant(pool.db, A, (tx) =>
        tx
          .insert(inboxes)
          .values({ accountId: A, name: 'tg', channelType: 'telegram', publicKey: 'pk_tg_chan' }),
      ),
    ).rejects.toThrow();
  });
});
