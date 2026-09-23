import { Writable } from 'node:stream';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggerOptions } from './logger.js';
import { currentTraceContext, tracer, withEventSpan } from './telemetry.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

describe('tracing', () => {
  it('sem trace ativo não há traceparent', () => {
    expect(currentTraceContext()).toBeUndefined();
  });

  it('o span do worker continua o trace da requisição que gerou o evento', async () => {
    exporter.reset();
    let traceparent: string | undefined;
    let requestSpanId = '';
    let requestTraceId = '';
    await tracer().startActiveSpan('POST /auth/register', async (span) => {
      traceparent = currentTraceContext(); // é isto que o outbox grava junto do evento
      requestSpanId = span.spanContext().spanId;
      requestTraceId = span.spanContext().traceId;
      span.end();
      await Promise.resolve();
    });
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    // ...tempo depois, em outro processo: só o traceparent atravessou a fila
    await withEventSpan('event account.created', traceparent, { 'event.id': 'x' }, () =>
      Promise.resolve(),
    );
    const worker = exporter.getFinishedSpans().find((s) => s.name === 'event account.created');
    expect(worker?.spanContext().traceId).toBe(requestTraceId);
    expect(worker?.parentSpanContext?.spanId).toBe(requestSpanId);
  });

  it('erro no handler marca o span como falho e propaga', async () => {
    exporter.reset();
    await expect(
      withEventSpan('event x', undefined, {}, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    const s = exporter.getFinishedSpans()[0];
    expect(s?.status.code).toBe(2); // ERROR
    expect(s?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('o logger inclui trace_id e span_id do span ativo', async () => {
    const lines: string[] = [];
    const log = pino(
      loggerOptions('info', 't'),
      new Writable({
        write(c: Buffer, _e, cb) {
          lines.push(c.toString());
          cb();
        },
      }),
    );
    let traceId = '';
    await tracer().startActiveSpan('op', async (span) => {
      traceId = span.spanContext().traceId;
      log.info('dentro do span');
      span.end();
      await Promise.resolve();
    });
    log.info('fora do span');
    expect(JSON.parse(lines[0] ?? '{}').trace_id).toBe(traceId);
    expect(JSON.parse(lines[1] ?? '{}').trace_id).toBeUndefined();
  });
});
