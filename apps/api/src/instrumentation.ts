import { initTelemetry } from '@waychat/shared';

/**
 * Carregado ANTES do servidor: `node --import ./dist/instrumentation.js dist/server.js`.
 * As instrumentações de http/pg/ioredis precisam ser registradas antes desses módulos serem importados.
 */
export const telemetry = initTelemetry({
  service: 'waychat-api',
  endpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
});
