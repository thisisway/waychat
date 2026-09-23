import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executa `fn` numa transação em que a RLS enxerga apenas o tenant `accountId`.
 * `set_config(..., true)` vale só até o fim da transação, então uma conexão devolvida ao pool nunca carrega o tenant anterior.
 */
export async function withTenant<T>(
  db: Db,
  accountId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(accountId)) throw new Error('withTenant: accountId inválido');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.account_id', ${accountId}, true)`);
    return fn(tx);
  });
}

/**
 * Transação em que o usuário já autenticado `userId` pode LER as próprias associações (`account_users`),
 * usada no login para descobrir as contas antes de existir um tenant. Não concede acesso a mais nada.
 */
export async function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error('withUser: userId inválido');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
