import type { FastifyInstance } from 'fastify';
import { Counter, Histogram, type Registry } from 'prom-client';

/**
 * Métricas HTTP. O rótulo `route` é o padrão da rota (`/members/:id`), nunca a URL real: evita explosão de cardinalidade
 * e não coloca ids de clientes nas métricas.
 */
export function registerHttpMetrics(app: FastifyInstance, registry: Registry): void {
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Latência das requisições HTTP',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  const errors = new Counter({
    name: 'http_server_errors_total',
    help: 'Respostas 5xx',
    labelNames: ['route'],
    registers: [registry],
  });

  app.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions.url ?? 'nao_encontrada';
    duration.observe(
      { method: req.method, route, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    if (reply.statusCode >= 500) errors.inc({ route });
    done();
  });
}
