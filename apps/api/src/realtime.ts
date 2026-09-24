import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import {
  actorForSession,
  authenticate,
  canSeeEvent,
  currentCursor,
  loadEventScope,
  loadVisibleConversation,
  type AuthenticatedActor,
  type Ctx,
  type EventScope,
} from '@waychat/core';
import { withTenant } from '@waychat/db';
import { eventEnvelopeSchema, type Env, type EventEnvelope } from '@waychat/shared';
import { parseCookie } from 'cookie';
import type { Redis } from 'ioredis';
import { Counter, Gauge, type Registry } from 'prom-client';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { COOKIE } from './cookies.js';

/** Onde chegam os eventos publicados pelo relay do outbox. Em produção é o Valkey; nos testes, qualquer fonte. */
export interface EventFeed {
  start: (onEvent: (event: EventEnvelope) => void) => Promise<void>;
  stop: () => Promise<void>;
}

export const EVENTS_PATTERN = 'wc:events:*';

/** Assina `wc:events:*` (o relay publica em `wc:events:{account_id}`). Usa uma conexão dedicada: assinatura bloqueia a conexão. */
export function createRedisFeed(redis: Redis): EventFeed {
  let sub: Redis | null = null;
  return {
    start: async (onEvent) => {
      sub = redis.duplicate();
      sub.on('pmessage', (_pattern, _channel, message) => {
        try {
          const parsed = eventEnvelopeSchema.safeParse(JSON.parse(message));
          if (parsed.success) onEvent(parsed.data);
        } catch {
          // mensagem malformada no canal: ignora (nunca derruba o gateway)
        }
      });
      await sub.psubscribe(EVENTS_PATTERN);
    },
    stop: async () => {
      if (sub) {
        await sub.quit().catch(() => undefined);
        sub = null;
      }
    },
  };
}

export interface RealtimeOptions {
  httpServer: HttpServer;
  env: Env;
  ctx: Ctx;
  feed: EventFeed;
  /** Com Valkey, o adaptador replica salas (digitação, quem está vendo) entre instâncias da API. */
  redis?: Redis | null;
  /** Reavaliação periódica das conexões abertas (sessão revogada, membro removido). */
  revalidateEveryMs?: number;
  metrics?: Registry;
}

export interface Realtime {
  io: Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>;
  /** Reavalia agora todas as conexões (o teste chama; em produção roda por temporizador). */
  revalidateAll: () => Promise<void>;
  close: () => Promise<void>;
}

export interface ServerToClient {
  event: (e: EventEnvelope) => void;
  ready: (p: { cursor: number; online: string[] }) => void;
  'presence.updated': (p: { user_id: string; status: 'online' | 'offline' }) => void;
  'viewer.joined': (p: { conversation_id: string; user_id: string }) => void;
  'viewer.left': (p: { conversation_id: string; user_id: string }) => void;
  typing: (p: { conversation_id: string; user_id: string; on: boolean }) => void;
}

export interface ClientToServer {
  join_conversation: (
    payload: unknown,
    ack?: (r: { ok: boolean; viewers?: string[] }) => void,
  ) => void;
  leave_conversation: (payload: unknown) => void;
  typing: (payload: unknown) => void;
}

interface SocketData {
  token: string;
  actor: AuthenticatedActor;
  scope: EventScope;
  typingTokens: number;
  typingAt: number;
}

type AppSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, SocketData>;

const MAX_SOCKETS_PER_USER = 10;
const conversationRoom = (id: string) => `conversation:${id}`;
const userRoom = (id: string) => `user:${id}`;
const accountRoom = (id: string) => `account:${id}`;

const uuidPayload = z.object({ conversation_id: z.uuid() });
const typingPayload = uuidPayload.extend({ on: z.boolean() });

/**
 * Gateway em tempo real (Socket.IO). Regras:
 *  - autentica pelo MESMO cookie de sessão do painel; a origem do handshake precisa ser a do painel
 *    (sem isso, qualquer site aberto no navegador do atendente poderia abrir a conexão dele);
 *  - cada evento vai só para quem também o obteria pela API (`canSeeEvent`, a mesma regra do /sync);
 *  - visibilidade é recalculada quando muda o papel, a associação a inboxes ou a sessão;
 *  - entrar numa sala de conversa passa por checagem de acesso; digitação tem limite de taxa.
 */
export async function attachRealtime(opts: RealtimeOptions): Promise<Realtime> {
  const { ctx, env } = opts;
  const allowedOrigin = new URL(env.PUBLIC_URL).origin;

  const io = new Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>(
    opts.httpServer,
    {
      path: '/socket.io',
      serveClient: false,
      maxHttpBufferSize: 16 * 1024,
      pingInterval: 20_000,
      pingTimeout: 20_000,
      cors: { origin: allowedOrigin, credentials: true },
      // Origin do handshake (polling e websocket): recusa antes de qualquer autenticação.
      allowRequest: (req, cb) => {
        const origin = req.headers.origin;
        cb(null, origin === undefined || origin === allowedOrigin);
      },
    },
  );

  if (opts.redis) {
    io.adapter(createAdapter(opts.redis.duplicate(), opts.redis.duplicate()));
  }

  const connections = opts.metrics
    ? new Gauge({
        name: 'ws_connections',
        help: 'Conexões WebSocket abertas',
        registers: [opts.metrics],
      })
    : null;
  const delivered = opts.metrics
    ? new Counter({
        name: 'ws_events_delivered_total',
        help: 'Eventos entregues por WebSocket',
        registers: [opts.metrics],
      })
    : null;
  const rejected = opts.metrics
    ? new Counter({
        name: 'ws_rejected_total',
        help: 'Conexões recusadas',
        labelNames: ['reason'],
        registers: [opts.metrics],
      })
    : null;

  // ---- autenticação do handshake
  io.use((socket, next) => {
    void (async () => {
      try {
        const token = parseCookie(socket.request.headers.cookie ?? '')[COOKIE.access];
        if (!token) throw new Error('no_cookie');
        const actor = await authenticate(ctx, token);
        const existing = await io.in(userRoom(actor.userId)).fetchSockets();
        if (existing.length >= MAX_SOCKETS_PER_USER) {
          rejected?.inc({ reason: 'too_many' });
          next(new Error('too_many_connections'));
          return;
        }
        socket.data.token = token;
        socket.data.actor = actor;
        socket.data.scope = await loadEventScope(ctx, actor);
        socket.data.typingTokens = 5;
        socket.data.typingAt = Date.now();
        next();
      } catch {
        rejected?.inc({ reason: 'unauthorized' });
        next(new Error('unauthorized')); // mensagem única: não diz se faltou cookie, expirou ou foi revogado
      }
    })();
  });

  // ---- reavaliação de uma conexão (permissões, inboxes, sessão)
  async function refresh(socket: AppSocket): Promise<void> {
    const d = socket.data;
    const actor = await actorForSession(ctx, {
      userId: d.actor.userId,
      accountId: d.actor.accountId,
      familyId: d.actor.familyId,
      mfaVerified: d.actor.mfaVerified,
    });
    if (!actor) {
      socket.disconnect(true);
      return;
    }
    d.actor = actor;
    d.scope = await loadEventScope(ctx, actor);
    // deixa as salas de conversa que deixou de poder ver
    for (const room of socket.rooms) {
      if (!room.startsWith('conversation:')) continue;
      const id = room.slice('conversation:'.length);
      const visible = await withTenant(ctx.db, actor.accountId, (tx) =>
        loadVisibleConversation(tx, actor, id).then(
          () => true,
          () => false,
        ),
      );
      if (!visible) await socket.leave(room);
    }
  }

  const socketsOf = (accountId: string, userId?: string): AppSocket[] =>
    [...io.sockets.sockets.values()].filter(
      (s) =>
        s.data.actor.accountId === accountId &&
        (userId === undefined || s.data.actor.userId === userId),
    );

  // ---- distribuição dos eventos (em fila: preserva a ordem e recalcula a visibilidade ANTES de entregar)
  let chain: Promise<void> = Promise.resolve();
  const dispatch = async (event: EventEnvelope): Promise<void> => {
    if (
      event.type === 'inbox.updated' ||
      event.type === 'inbox.created' ||
      event.type === 'inbox.deleted'
    ) {
      await Promise.all(socketsOf(event.account_id).map((s) => refresh(s)));
    } else if (event.type === 'member.role_changed' || event.type === 'member.removed') {
      const userId = (event.payload as { user_id?: string }).user_id;
      if (userId) await Promise.all(socketsOf(event.account_id, userId).map((s) => refresh(s)));
    }
    for (const s of socketsOf(event.account_id)) {
      if (s.connected && canSeeEvent(s.data.scope, event)) {
        s.emit('event', event);
        delivered?.inc();
      }
    }
  };
  await opts.feed.start((event) => {
    chain = chain.then(() => dispatch(event)).catch(() => undefined);
  });

  // ---- conexões
  io.on('connection', (raw) => {
    const socket = raw;
    const { actor } = socket.data;
    connections?.inc();
    void socket.join([userRoom(actor.userId), accountRoom(actor.accountId)]);

    void (async () => {
      const online = new Set(
        (await io.in(accountRoom(actor.accountId)).fetchSockets()).map((s) => s.data.actor.userId),
      );
      socket.emit('ready', { cursor: await currentCursor(ctx, actor), online: [...online] });
      if ((await io.in(userRoom(actor.userId)).fetchSockets()).length === 1) {
        socket
          .to(accountRoom(actor.accountId))
          .emit('presence.updated', { user_id: actor.userId, status: 'online' });
      }
    })();

    socket.on(
      'join_conversation',
      (payload: unknown, ack?: (r: { ok: boolean; viewers?: string[] }) => void) => {
        void (async () => {
          const parsed = uuidPayload.safeParse(payload);
          if (!parsed.success) return ack?.({ ok: false });
          const id = parsed.data.conversation_id;
          const visible = await withTenant(ctx.db, socket.data.actor.accountId, (tx) =>
            loadVisibleConversation(tx, socket.data.actor, id).then(
              () => true,
              () => false,
            ),
          );
          if (!visible) return ack?.({ ok: false }); // mesma resposta para "não existe" e "não pode ver"
          const room = conversationRoom(id);
          const viewers = new Set(
            (await io.in(room).fetchSockets()).map((s) => s.data.actor.userId),
          );
          await socket.join(room);
          socket
            .to(room)
            .emit('viewer.joined', { conversation_id: id, user_id: socket.data.actor.userId });
          ack?.({ ok: true, viewers: [...viewers].filter((u) => u !== socket.data.actor.userId) });
        })();
      },
    );

    socket.on('leave_conversation', (payload: unknown) => {
      const parsed = uuidPayload.safeParse(payload);
      if (!parsed.success) return;
      const room = conversationRoom(parsed.data.conversation_id);
      if (!socket.rooms.has(room)) return;
      void socket.leave(room);
      socket.to(room).emit('viewer.left', {
        conversation_id: parsed.data.conversation_id,
        user_id: actor.userId,
      });
    });

    // Digitação: só dentro de uma sala que o usuário conseguiu abrir; no máximo 5 avisos por segundo.
    socket.on('typing', (payload: unknown) => {
      const parsed = typingPayload.safeParse(payload);
      if (!parsed.success) return;
      const room = conversationRoom(parsed.data.conversation_id);
      if (!socket.rooms.has(room)) return;
      const d = socket.data;
      const now = Date.now();
      d.typingTokens = Math.min(5, d.typingTokens + ((now - d.typingAt) / 1000) * 5);
      d.typingAt = now;
      if (d.typingTokens < 1) return;
      d.typingTokens -= 1;
      socket.to(room).emit('typing', {
        conversation_id: parsed.data.conversation_id,
        user_id: d.actor.userId,
        on: parsed.data.on,
      });
    });

    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (room.startsWith('conversation:')) {
          socket.to(room).emit('viewer.left', {
            conversation_id: room.slice('conversation:'.length),
            user_id: actor.userId,
          });
        }
      }
    });

    socket.on('disconnect', () => {
      connections?.dec();
      void (async () => {
        if ((await io.in(userRoom(actor.userId)).fetchSockets()).length === 0) {
          io.to(accountRoom(actor.accountId)).emit('presence.updated', {
            user_id: actor.userId,
            status: 'offline',
          });
        }
      })();
    });
  });

  const revalidateAll = async () => {
    await Promise.all([...io.sockets.sockets.values()].map((s) => refresh(s)));
  };
  const timer = setInterval(
    () => void revalidateAll().catch(() => undefined),
    opts.revalidateEveryMs ?? 60_000,
  );
  timer.unref();

  return {
    io,
    revalidateAll,
    close: async () => {
      clearInterval(timer);
      await opts.feed.stop();
      await io.close();
    },
  };
}
