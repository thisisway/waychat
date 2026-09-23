import { initTelemetry } from '@waychat/shared';

/** Carregado ANTES do worker: `node --import ./dist/instrumentation.js dist/main.js`. */
export const telemetry = initTelemetry({
  service: 'waychat-worker',
  endpoint: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
});
