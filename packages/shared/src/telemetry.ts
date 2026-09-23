import {
  context,
  propagation,
  trace,
  SpanStatusCode,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface Telemetry {
  shutdown: () => Promise<void>;
}

/**
 * Liga o tracing OpenTelemetry (exporta por OTLP/HTTP). Sem `endpoint` não faz nada: o custo é zero e as APIs
 * de propagação abaixo viram no-op. Precisa rodar ANTES de importar http/pg/ioredis: use `node --import ./dist/instrumentation.js`.
 * Instrumenta só o que importa (HTTP, Postgres, Valkey) para manter o overhead baixo.
 */
export function initTelemetry(opts: { service: string; endpoint?: string | undefined }): Telemetry {
  if (!opts.endpoint) return { shutdown: () => Promise.resolve() };
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': opts.service }),
    traceExporter: new OTLPTraceExporter({ url: `${opts.endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (r) => (r.url ?? '').startsWith('/health'),
      }),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}

export const tracer = (name = 'waychat'): Tracer => trace.getTracer(name);

/** Serializa o contexto de trace ativo no formato W3C `traceparent` (ou `undefined` se não houver trace ativo). */
export function currentTraceContext(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier['traceparent'];
}

export function contextFromTraceparent(traceparent: string | undefined): Context {
  return traceparent ? propagation.extract(context.active(), { traceparent }) : context.active();
}

/** Executa `fn` dentro de um span filho do trace que originou o evento (fila -> worker). */
export async function withEventSpan<T>(
  name: string,
  traceparent: string | undefined,
  attributes: Record<string, string | number>,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    { attributes },
    contextFromTraceparent(traceparent),
    async (span: Span) => {
      try {
        return await fn();
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/** Ids do span ativo, para correlacionar logs com traces. */
export function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}
