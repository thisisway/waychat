import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import { refreshSession } from './api.js';

export type RealtimeStatus = 'connecting' | 'online' | 'offline';

interface EventEnvelope {
  event_id: string;
  cursor: number;
  type: string;
  payload: Record<string, unknown>;
}

interface SyncResponse {
  events: EventEnvelope[];
  cursor: number;
  has_more: boolean;
}

// ---- estado global (uma conexão por aba)
let socket: Socket | null = null;
let status: RealtimeStatus = 'connecting';
const listeners = new Set<() => void>();
const setStatus = (s: RealtimeStatus) => {
  status = s;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const useRealtimeStatus = (): RealtimeStatus =>
  useSyncExternalStore(subscribe, () => status);
/** Usado pelas consultas: com o WebSocket no ar o polling vira só rede de segurança. */
export const realtimeOnline = () => status === 'online';

/**
 * Aplica um evento ao cache: em vez de mesclar dados (que exigiria repetir a regra de visibilidade no cliente),
 * marca as consultas afetadas como desatualizadas e deixa a API — que já filtra por permissão — responder de novo.
 */
export function applyEvent(qc: QueryClient, e: Pick<EventEnvelope, 'type' | 'payload'>): void {
  const family = e.type.split('.')[0];
  const conversationId = e.payload['conversation_id'];
  if (family === 'conversation' || family === 'message') {
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    void qc.invalidateQueries({ queryKey: ['counts'] });
    if (typeof conversationId === 'string') {
      void qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      if (family === 'message')
        void qc.invalidateQueries({ queryKey: ['messages', conversationId] });
    }
  } else if (family === 'inbox') {
    void qc.invalidateQueries({ queryKey: ['inboxes'] });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    void qc.invalidateQueries({ queryKey: ['counts'] });
  } else if (family === 'contact') {
    void qc.invalidateQueries({ queryKey: ['contacts'] });
  }
}

const SEEN_LIMIT = 2000;

/**
 * Liga o tempo real. Reconectou? Pede `GET /sync?since=<último cursor>` e aplica o que perdeu, deduplicando por
 * `event_id` (um evento pode chegar ao vivo e também no /sync). Devolve a função que encerra tudo.
 */
export function startRealtime(qc: QueryClient, onSessionLost: () => void): () => void {
  let lastCursor: number | null = null;
  const seen = new Set<string>();
  let stopped = false;

  const handle = (e: EventEnvelope) => {
    if (seen.has(e.event_id)) return;
    seen.add(e.event_id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
    if (lastCursor === null || e.cursor > lastCursor) lastCursor = e.cursor;
    applyEvent(qc, e);
  };

  async function catchUp(): Promise<void> {
    if (lastCursor === null) return;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`/sync?since=${String(lastCursor)}&limit=200`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const body = (await res.json()) as SyncResponse;
      for (const e of body.events) handle(e);
      lastCursor = Math.max(lastCursor, body.cursor);
      if (!body.has_more) return;
    }
  }

  const s = io({
    path: '/socket.io',
    transports: ['websocket'],
    withCredentials: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  socket = s;

  s.on('ready', (r: { cursor: number }) => {
    const reconnecting = lastCursor !== null;
    lastCursor ??= r.cursor;
    setStatus('online');
    if (reconnecting) void catchUp().finally(() => void qc.invalidateQueries());
  });
  s.on('event', handle);
  s.on('disconnect', () => {
    if (!stopped) setStatus('offline');
  });
  s.on('connect_error', () => {
    setStatus('offline');
    // handshake recusado quase sempre é o access token vencido: renova pela sessão e tenta de novo
    void refreshSession().then((ok) => {
      if (stopped) return;
      if (ok) s.connect();
      else onSessionLost();
    });
  });

  return () => {
    stopped = true;
    s.disconnect();
    socket = null;
    setStatus('connecting');
  };
}

// ---- presença dentro de uma conversa: quem está vendo e quem está digitando
export function useConversationPresence(conversationId: string): {
  others: number;
  typing: boolean;
} {
  const [viewers, setViewers] = useState(0);
  const [typing, setTyping] = useState(false);
  const online = useRealtimeStatus() === 'online';

  useEffect(() => {
    const s = socket;
    if (!s || !online) return;
    let typingTimer: ReturnType<typeof setTimeout> | undefined;
    const mine = (p: { conversation_id: string }) => p.conversation_id === conversationId;

    const onJoined = (p: { conversation_id: string }) => {
      if (mine(p)) setViewers((v) => v + 1);
    };
    const onLeft = (p: { conversation_id: string }) => {
      if (mine(p)) setViewers((v) => Math.max(0, v - 1));
    };
    const onTyping = (p: { conversation_id: string; on: boolean }) => {
      if (!mine(p)) return;
      setTyping(p.on);
      clearTimeout(typingTimer);
      // quem para de digitar sem avisar (aba fechada) não deixa o indicador preso
      if (p.on)
        typingTimer = setTimeout(() => {
          setTyping(false);
        }, 5000);
    };
    s.on('viewer.joined', onJoined);
    s.on('viewer.left', onLeft);
    s.on('typing', onTyping);
    s.emit(
      'join_conversation',
      { conversation_id: conversationId },
      (r: { ok: boolean; viewers?: string[] }) => {
        if (r.ok) setViewers(r.viewers?.length ?? 0);
      },
    );
    return () => {
      clearTimeout(typingTimer);
      s.off('viewer.joined', onJoined);
      s.off('viewer.left', onLeft);
      s.off('typing', onTyping);
      s.emit('leave_conversation', { conversation_id: conversationId });
      setViewers(0);
      setTyping(false);
    };
  }, [conversationId, online]);

  return { others: viewers, typing };
}

/** Avisa "estou digitando" (com limite: no máximo um aviso a cada 2,5 s enquanto digita). */
export function makeTypingNotifier(conversationId: string): (on: boolean) => void {
  let last = 0;
  return (on) => {
    if (!socket?.connected) return;
    const now = Date.now();
    if (on && now - last < 2500) return;
    last = on ? now : 0;
    socket.emit('typing', { conversation_id: conversationId, on });
  };
}
