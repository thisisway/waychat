import { z } from 'zod';

const base64Key32 = z
  .string()
  .refine(
    (v) => Buffer.from(v, 'base64').length === 32,
    'deve ser 32 bytes em base64 (openssl rand -base64 32)',
  );

const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_URL: z.url(),
  /** Ligar só atrás de um proxy confiável (Caddy): passa a usar X-Forwarded-For para o IP do cliente. */
  TRUST_PROXY: z.stringbool().default(false),
  /** Porta do /metrics (Prometheus), separada da API pública. */
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  /** Porta do /metrics do worker (processo separado da API, que usa METRICS_PORT). */
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9465),
  /** Interface do /metrics. Padrão só local; em Docker use 0.0.0.0 e NÃO publique a porta. */
  METRICS_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url(),
  DATABASE_OWNER_URL: z.url().optional(),
  DATABASE_RELAY_URL: z.url().optional(),
  VALKEY_URL: z.url(),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  MASTER_KEY: base64Key32,
  /** Chaves antigas (separadas por vírgula) só para DECIFRAR durante uma rotação. */
  MASTER_KEY_PREVIOUS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .transform((v) => v.split(',').map((k) => k.trim()))
      .pipe(z.array(base64Key32))
      .optional(),
  ),
  SESSION_SECRET: z.string().min(32, 'mínimo 32 caracteres'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyToUndefined, z.url().optional()),
});

export type Env = z.infer<typeof envSchema>;

/** Valida o ambiente na subida. Falha rápida, listando só os NOMES das variáveis inválidas (nunca os valores). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${problems}`);
  }
  return result.data;
}
