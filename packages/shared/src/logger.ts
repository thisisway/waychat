import { pino, type Logger, type LoggerOptions } from 'pino';
import { activeTraceIds } from './telemetry.js';

/** Chaves que nunca devem aparecer em log, em qualquer profundidade rasa (0–3 níveis). */
const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'secret',
  'secretEncrypted',
  'challenge',
  'code',
  'recovery_code',
  'recoveryCode',
  'apiKey',
  'api_key',
  'authorization',
  'cookie',
  'content',
  'body',
  'email',
];

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]),
];

export const REDACTED = '[redacted]';

export function loggerOptions(level: string, service: string): LoggerOptions {
  return {
    level,
    base: { service },
    // trace_id/span_id do span ativo: liga cada linha de log ao trace correspondente
    mixin: () => activeTraceIds(),
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  };
}

export function createLogger(level: string, service: string): Logger {
  return pino(loggerOptions(level, service));
}
