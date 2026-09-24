import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type { Ctx } from '@waychat/core';
import { loggerOptions, uuidv7, type Env } from '@waychat/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import type { Registry } from 'prom-client';
import { registerHttpMetrics } from './metrics.js';
import { registerAccessControl } from './plugins/access.js';
import { attachRealtime, type EventFeed, type Realtime } from './realtime.js';
import { registerErrorHandling } from './plugins/errors.js';
import { adminRoutes } from './routes/admin.js';
import { contactRoutes } from './routes/contacts.js';
import { conversationRoutes } from './routes/conversations.js';
import { inboxRoutes } from './routes/inboxes.js';
import { attachmentRoutes } from './routes/attachments.js';
import { channelApiRoutes } from './routes/channel-api.js';
import { syncRoutes } from './routes/sync.js';
import { whatsappRoutes } from './routes/whatsapp.js';
import { widgetRoutes } from './routes/widget.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { access, type Access } from './types.js';

export interface AppDeps {
  env: Env;
  ctx: Ctx;
  /** Valkey: usado no rate limit compartilhado entre instâncias e no health/ready. Sem ele, o limite é em memória. */
  redis?: Redis | null;
  /** Registro Prometheus; sem ele, nenhuma métrica HTTP é coletada. */
  metrics?: Registry;
  /** Gateway WebSocket: precisa de uma fonte de eventos (Valkey em produção). Sem ela, não há tempo real. */
  realtime?: { feed: EventFeed; revalidateEveryMs?: number };
  /** `false` silencia os logs (testes). */
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  realtime: Realtime | null;
  /** Todas as rotas registradas e a forma de acesso de cada uma. */
  routeAccess: Map<string, Access>;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { env, ctx } = deps;
  const app = Fastify({
    logger: deps.logger === false ? false : loggerOptions(env.LOG_LEVEL, 'api'),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    // Aceita X-Request-Id do proxy só se for um UUID; caso contrário gera um novo (evita injeção em logs).
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && /^[0-9a-f-]{36}$/i.test(h) ? h : uuidv7();
    },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: { title: 'WayChat API', version: '0.0.0' },
      components: {
        securitySchemes: {
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'wc_at' },
          bearerAuth: { type: 'http', scheme: 'bearer', description: 'Chave de API (wc_…)' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  // API só devolve JSON: CSP fechada (nada de scripts/estilos/frames). O painel web define a própria CSP com nonce.
  await app.register(helmet, {
    frameguard: { action: 'deny' },
    contentSecurityPolicy: {
      useDefaults: false, // só as diretivas abaixo: nada herdado do padrão do helmet
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    hsts: env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  const panelCors = {
    origin: new URL(env.PUBLIC_URL).origin,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
    maxAge: 600,
  };
  // O widget roda no site do cliente: qualquer origem pode CHAMAR /widget/*, mas sem cookies (só Bearer).
  // Quem pode abrir sessão é decidido pela lista de origens da inbox, dentro do caso de uso.
  const widgetCors = {
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'authorization'],
    maxAge: 600,
  };
  await app.register(cors, {
    delegator: (req, cb) => {
      cb(null, req.url.startsWith('/widget/') ? widgetCors : panelCors);
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    ...(deps.redis ? { redis: deps.redis, nameSpace: 'wc:rl:' } : {}),
  });

  if (deps.metrics) registerHttpMetrics(app, deps.metrics);
  registerErrorHandling(app);
  const routeAccess = registerAccessControl(app, env, ctx);

  healthRoutes(app, { db: ctx.db, redis: deps.redis ?? null });
  authRoutes(app, env, ctx);
  adminRoutes(app, ctx);
  inboxRoutes(app, ctx);
  contactRoutes(app, ctx);
  conversationRoutes(app, ctx);
  syncRoutes(app, ctx);
  channelApiRoutes(app, ctx);
  widgetRoutes(app, ctx);
  attachmentRoutes(app, ctx);
  whatsappRoutes(app, ctx);
  app.get('/openapi.json', { config: access.public }, () => app.swagger());

  // requestId também no header de resposta para correlação com os logs
  app.addHook('onSend', (req, reply, payload, done) => {
    void reply.header('x-request-id', req.id);
    done(null, payload);
  });

  let realtime: Realtime | null = null;
  if (deps.realtime) {
    realtime = await attachRealtime({
      httpServer: app.server,
      env,
      ctx,
      feed: deps.realtime.feed,
      redis: deps.redis ?? null,
      ...(deps.realtime.revalidateEveryMs
        ? { revalidateEveryMs: deps.realtime.revalidateEveryMs }
        : {}),
      ...(deps.metrics ? { metrics: deps.metrics } : {}),
    });
    const rt = realtime;
    app.addHook('onClose', async () => {
      await rt.close();
    });
  }
  return { app, routeAccess, realtime };
}
