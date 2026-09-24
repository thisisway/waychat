import type { Db } from '@waychat/db';
import type { Env } from '@waychat/shared';
import type { ObjectStore, Scanner } from '@waychat/storage';
import { Keyring } from './crypto/envelope.js';

export interface CoreConfig {
  sessionSecret: string;
  masterKey: string;
  masterKeyPrevious: readonly string[];
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  challengeTtlSeconds: number;
  /** Nome exibido no app autenticador. */
  issuer: string;
}

/** Anexos: armazenamento, antivírus e a fila de varredura. Ausente = anexos desligados. */
export interface FileServices {
  store: ObjectStore;
  /** `null` = sem antivírus (só desenvolvimento): o arquivo passa direto para "limpo". */
  scanner: Scanner | null;
  enqueueScan: (accountId: string, attachmentId: string) => Promise<void>;
}

export interface Ctx {
  db: Db;
  config: CoreConfig;
  keyring: Keyring;
  /** Relógio injetável (testes de bloqueio, expiração e TOTP). */
  now: () => Date;
  files?: FileServices;
}

export function coreConfigFromEnv(
  env: Pick<Env, 'SESSION_SECRET' | 'MASTER_KEY' | 'MASTER_KEY_PREVIOUS'>,
): CoreConfig {
  return {
    sessionSecret: env.SESSION_SECRET,
    masterKey: env.MASTER_KEY,
    masterKeyPrevious: env.MASTER_KEY_PREVIOUS ?? [],
    accessTtlSeconds: 10 * 60,
    refreshTtlSeconds: 30 * 24 * 60 * 60,
    challengeTtlSeconds: 5 * 60,
    issuer: 'WayChat',
  };
}

export function createCtx(
  db: Db,
  config: CoreConfig,
  now: () => Date = () => new Date(),
  files?: FileServices,
): Ctx {
  return {
    db,
    config,
    keyring: new Keyring(config.masterKey, config.masterKeyPrevious),
    now,
    ...(files ? { files } : {}),
  };
}
