import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://waychat_app:pw@127.0.0.1:5432/waychat',
  VALKEY_URL: 'redis://:pw@127.0.0.1:6379',
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'waychat',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SECRET: 'x'.repeat(32),
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
};

describe('loadEnv', () => {
  it('aceita ambiente válido e aplica defaults', () => {
    const env = loadEnv(valid);
    expect(env.API_PORT).toBe(3000);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('falha listando variáveis inválidas sem vazar valores', () => {
    const secret = 'segredo-curto';
    expect(() => loadEnv({ ...valid, SESSION_SECRET: secret, MASTER_KEY: '' })).toThrow(
      /SESSION_SECRET[\s\S]*MASTER_KEY|MASTER_KEY[\s\S]*SESSION_SECRET/,
    );
    try {
      loadEnv({ ...valid, SESSION_SECRET: secret });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('rejeita MASTER_KEY que não tem 32 bytes', () => {
    expect(() => loadEnv({ ...valid, MASTER_KEY: Buffer.alloc(16).toString('base64') })).toThrow(
      /MASTER_KEY/,
    );
  });
});
