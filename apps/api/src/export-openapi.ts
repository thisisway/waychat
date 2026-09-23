import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createCtx } from '@waychat/core';
import { createDb } from '@waychat/db';
import { buildApp } from './app.js';

/** Gera docs/api/openapi.json a partir das rotas (sem conectar em nada: a conexão do pool é preguiçosa). */
const env = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
  PUBLIC_URL: 'http://localhost:3000',
  TRUST_PROXY: false,
  API_PORT: 3000,
  METRICS_PORT: 9464,
  WORKER_METRICS_PORT: 9465,
  METRICS_HOST: '127.0.0.1',
  DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
  VALKEY_URL: 'redis://127.0.0.1:1',
  S3_ENDPOINT: 'http://127.0.0.1:1',
  S3_REGION: 'x',
  S3_BUCKET: 'x',
  S3_ACCESS_KEY: 'x',
  S3_SECRET_KEY: 'x',
  MASTER_KEY: Buffer.alloc(32).toString('base64'),
  SESSION_SECRET: 'x'.repeat(32),
} as const;

const handle = createDb(env.DATABASE_URL, { max: 1 });
const ctx = createCtx(handle.db, {
  sessionSecret: env.SESSION_SECRET,
  masterKey: env.MASTER_KEY,
  masterKeyPrevious: [],
  accessTtlSeconds: 600,
  refreshTtlSeconds: 1,
  challengeTtlSeconds: 1,
  issuer: 'WayChat',
});
const { app } = await buildApp({ env, ctx, logger: false });
await app.ready();
const out = resolve(process.argv[2] ?? '../../docs/api/openapi.json');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
await handle.close();
console.log(`OpenAPI escrito em ${out}`);
