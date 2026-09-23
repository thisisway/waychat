import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@waychat/shared';
import { withTenant } from './tenant.js';
import { startTestDb, type TestDb } from './test-db.js';
import { accounts, auditLogs, outbox, roles, users } from './schema/index.js';

let t: TestDb;

/**
 * Únicas tabelas com account_id SEM RLS por tenant: são consultadas por token de refresh antes de existir tenant
 * (ADR-0002). Qualquer outra tabela nova com account_id precisa de RLS, senão o teste abaixo falha.
 */
const ACCOUNT_ID_WITHOUT_RLS = ['sessions'];

/** Drizzle embrulha o erro do Postgres em `cause`; checa a mensagem original. */
async function expectPgError(p: PromiseLike<unknown>, pattern: RegExp) {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'era esperado um erro').toBeDefined();
  const e = err as { message: string; cause?: { message?: string } };
  expect(`${e.message} ${e.cause?.message ?? ''}`).toMatch(pattern);
}
const A = uuidv7();
const B = uuidv7();

async function seedTenant(accountId: string, slug: string) {
  await withTenant(t.app.db, accountId, async (tx) => {
    await tx.insert(accounts).values({ id: accountId, name: slug, slug });
    await tx.insert(roles).values({ accountId, name: 'Owner', isSystem: true });
    await tx.insert(outbox).values({
      accountId,
      aggregateType: 'conversation',
      aggregateId: uuidv7(),
      eventType: 'conversation.created',
      payload: { slug },
    });
    await tx.insert(auditLogs).values({ accountId, action: 'account.created' });
  });
}

beforeAll(async () => {
  t = await startTestDb();
  await seedTenant(A, 'tenant-a');
  await seedTenant(B, 'tenant-b');
});

afterAll(async () => {
  await t.stop();
});

describe('isolamento entre tenants (RLS)', () => {
  it('tenant A só enxerga as próprias linhas', async () => {
    const rows = await withTenant(t.app.db, A, (tx) => tx.select().from(roles));
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.accountId === A)).toBe(true);

    const accs = await withTenant(t.app.db, A, (tx) => tx.select().from(accounts));
    expect(accs.map((a) => a.id)).toEqual([A]);
  });

  it('tenant A não lê o outbox nem a auditoria do tenant B', async () => {
    const ob = await withTenant(t.app.db, A, (tx) => tx.select().from(outbox));
    expect(ob.map((r) => r.accountId)).toEqual([A]);
    const audit = await withTenant(t.app.db, A, (tx) => tx.select().from(auditLogs));
    expect(audit.map((r) => r.accountId)).toEqual([A]);
  });

  it('sem tenant definido nenhuma linha é visível (deny-by-default)', async () => {
    const rows = await t.app.db.select().from(roles);
    expect(rows).toHaveLength(0);
  });

  it('o tenant não vaza para a próxima transação na mesma conexão', async () => {
    // pool da aplicação tem max=1: todas as consultas reutilizam a mesma conexão
    await withTenant(t.app.db, A, (tx) => tx.select().from(roles));
    const after = await t.app.db.select().from(roles);
    expect(after).toHaveLength(0);
  });

  it('não escreve em outro tenant (WITH CHECK)', async () => {
    await expectPgError(
      withTenant(t.app.db, A, (tx) => tx.insert(roles).values({ accountId: B, name: 'Invasor' })),
      /row-level security|violates/i,
    );
  });

  it('UPDATE e DELETE cruzados não afetam nenhuma linha', async () => {
    const upd = await withTenant(t.app.db, A, (tx) =>
      tx
        .update(roles)
        .set({ name: 'hack' })
        .where(sql`${roles.accountId} = ${B}`)
        .returning(),
    );
    expect(upd).toHaveLength(0);
    const del = await withTenant(t.app.db, A, (tx) =>
      tx
        .delete(roles)
        .where(sql`${roles.accountId} = ${B}`)
        .returning(),
    );
    expect(del).toHaveLength(0);
    const still = await withTenant(t.app.db, B, (tx) => tx.select().from(roles));
    expect(still).toHaveLength(1);
  });

  it('a role da aplicação não é dona das tabelas nem ignora a RLS', async () => {
    const r = await t.owner.pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `select rolbypassrls, rolsuper from pg_roles where rolname = 'waychat_app'`,
    );
    expect(r.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const owned = await t.owner.pool.query(
      `select 1 from pg_tables where schemaname = 'public' and tableowner = 'waychat_app'`,
    );
    expect(owned.rowCount).toBe(0);
  });

  it('toda tabela com account_id tem RLS habilitada, forçada e com policy', async () => {
    const r = await t.owner.pool.query<{
      table_name: string;
      forced: boolean;
      enabled: boolean;
      policies: string;
    }>(
      `select c.relname as table_name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
              (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind = 'r'
          and c.relname <> all ($1)
          and (c.relname = 'accounts'
               or exists (select 1 from information_schema.columns col
                           where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'account_id'))`,
      [ACCOUNT_ID_WITHOUT_RLS],
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(8);
    for (const row of r.rows) {
      expect(row.enabled, `${row.table_name} sem RLS`).toBe(true);
      expect(row.forced, `${row.table_name} sem FORCE RLS`).toBe(true);
      expect(Number(row.policies), `${row.table_name} sem policy`).toBeGreaterThan(0);
    }
  });
});

describe('audit_logs é append-only', () => {
  it('a aplicação não consegue alterar nem apagar', async () => {
    await expectPgError(
      withTenant(t.app.db, A, (tx) => tx.update(auditLogs).set({ action: 'x' })),
      /permission denied|append-only/i,
    );
    await expectPgError(
      withTenant(t.app.db, A, (tx) => tx.delete(auditLogs)),
      /permission denied|append-only/i,
    );
  });

  it('nem o dono (superusuário) consegue: trigger bloqueia UPDATE, DELETE e TRUNCATE', async () => {
    await expectPgError(t.owner.pool.query(`update audit_logs set action = 'x'`), /append-only/);
    await expectPgError(t.owner.pool.query(`delete from audit_logs`), /append-only/);
    await expectPgError(t.owner.pool.query(`truncate audit_logs`), /append-only/);
  });

  it('evento global (sem conta) pode ser gravado, mas nenhum tenant o lê', async () => {
    await t.app.db
      .insert(auditLogs)
      .values({ action: 'login.failed', metadata: { email_hash: 'h' } });
    const rows = await withTenant(t.app.db, A, (tx) => tx.select().from(auditLogs));
    expect(rows.every((r) => r.accountId === A)).toBe(true);
  });

  it('não grava evento em nome de outro tenant', async () => {
    await expectPgError(
      withTenant(t.app.db, A, (tx) =>
        tx.insert(auditLogs).values({ accountId: B, action: 'forjado' }),
      ),
      /row-level security|violates/i,
    );
  });
});

describe('role do relay do outbox', () => {
  it('lê o outbox de todos os tenants e só pode marcar published_at', async () => {
    const all = await t.relay.db.select().from(outbox);
    expect(new Set(all.map((r) => r.accountId))).toEqual(new Set([A, B]));

    const done = await t.relay.db
      .update(outbox)
      .set({ publishedAt: new Date() })
      .where(sql`${outbox.accountId} = ${A}`)
      .returning({ id: outbox.id });
    expect(done).toHaveLength(1);

    await expectPgError(
      t.relay.db.update(outbox).set({ eventType: 'adulterado' }),
      /permission denied/i,
    );
  });

  it('não acessa outras tabelas', async () => {
    await expectPgError(t.relay.db.select().from(users), /permission denied/i);
    await expectPgError(t.relay.db.select().from(auditLogs), /permission denied/i);
  });
});
