import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Registry } from 'prom-client';

/** Registro próprio por processo (evita o global do prom-client e facilita testes). Já inclui métricas de runtime do Node. */
export function createRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return registry;
}

/**
 * Servidor de métricas SEPARADO da API pública: escuta em outra porta (padrão só em 127.0.0.1) para que o Caddy
 * nunca o exponha na internet. O Prometheus raspa `/metrics` por dentro da rede.
 */
export function startMetricsServer(registry: Registry, port: number, host = '127.0.0.1'): Server {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': registry.contentType });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(500).end();
        });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, host);
  return server;
}
