import type { Socket } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';
import { Chat, type ChatConfig, type ChatDeps, type Msg } from './chat.js';

class FakeSocket {
  handlers = new Map<string, ((...a: never[]) => void)[]>();
  disconnected = false;
  on(ev: string, fn: (...a: never[]) => void) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    return this;
  }
  off() {
    this.handlers.clear();
    return this;
  }
  disconnect() {
    this.disconnected = true;
    return this;
  }
  emit(ev: string, ...args: unknown[]) {
    for (const h of this.handlers.get(ev) ?? []) (h as (...a: unknown[]) => void)(...args);
  }
}

const msg = (over: Partial<Msg> = {}): Msg => ({
  id: crypto.randomUUID(),
  from: 'agent',
  content: 'oi',
  created_at: new Date().toISOString(),
  client_message_id: null,
  ...over,
});

interface Setup {
  chat: Chat;
  sockets: FakeSocket[];
  calls: { url: string; init: RequestInit }[];
  store: Map<string, string>;
}

function setup(
  opts: {
    cfg?: Partial<ChatConfig>;
    history?: Msg[];
    identified?: boolean;
    store?: Map<string, string>;
    failSend?: number;
  } = {},
): Setup {
  const sockets: FakeSocket[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const store = opts.store ?? new Map<string, string>();
  let failSend = opts.failSend ?? 0;
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const fetchFake = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/widget/v1/session')) {
      return json({
        token: 'tok',
        expires_at: new Date().toISOString(),
        visitor_id: opts.identified ? null : 'vis-1234567890abcdef',
        identified: opts.identified ?? false,
        inbox: { name: 'Site', welcome_message: null, primary_color: '#ff0000' },
      });
    }
    if (url.endsWith('/widget/v1/messages') && init.method === 'POST') {
      if (failSend > 0) {
        failSend--;
        return json({}, 500);
      }
      const b = JSON.parse(init.body as string) as { content: string; client_message_id: string };
      return json({
        message: msg({
          from: 'visitor',
          content: b.content,
          client_message_id: b.client_message_id,
        }),
        duplicate: false,
      });
    }
    return json({ items: opts.history ?? [] });
  }) as unknown as typeof fetch;
  const deps: ChatDeps = {
    fetch: fetchFake,
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as Socket;
    },
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    uuid: () => crypto.randomUUID(),
  };
  const chat = new Chat({ api: 'https://api.test', publicKey: 'ibx_x', ...opts.cfg }, deps);
  return { chat, sockets, calls, store };
}

describe('sessão e histórico', () => {
  it('abre a sessão, carrega o histórico, guarda o visitor_id e conecta o tempo real', async () => {
    const s = setup({ history: [msg()] });
    await s.chat.start();
    expect(s.chat.state).toMatchObject({ status: 'ready', needsProfile: false });
    expect(s.chat.state.messages).toHaveLength(1);
    expect(s.store.get('waychat:ibx_x:visitor')).toBe('vis-1234567890abcdef');
    expect(s.sockets).toHaveLength(1);
    s.sockets[0]?.emit('ready');
    expect(s.chat.state.online).toBe(true);
  });

  it('pré-chat só para quem nunca falou, não se identificou e não tem perfil salvo', async () => {
    const novo = setup();
    await novo.chat.start();
    expect(novo.chat.state.needsProfile).toBe(true);

    const identificado = setup({ identified: true });
    await identificado.chat.start();
    expect(identificado.chat.state.needsProfile).toBe(false);

    const comHistorico = setup({ history: [msg({ from: 'visitor' })] });
    await comHistorico.chat.start();
    expect(comHistorico.chat.state.needsProfile).toBe(false);
  });

  it('submitProfile guarda o perfil e reabre a sessão levando nome e e-mail', async () => {
    const s = setup();
    await s.chat.start();
    await s.chat.submitProfile(' Maria ', 'maria@exemplo.com');
    const last = s.calls.filter((c) => c.url.endsWith('/session')).at(-1);
    expect(JSON.parse(last?.init.body as string)).toMatchObject({
      public_key: 'ibx_x',
      visitor_id: 'vis-1234567890abcdef',
      name: 'Maria',
      email: 'maria@exemplo.com',
    });
    expect(s.chat.state.needsProfile).toBe(false);
  });

  it('visitante que volta reaproveita o visitor_id e conecta sozinho', () => {
    const store = new Map([['waychat:ibx_x:visitor', 'vis-1234567890abcdef']]);
    const s = setup({ store });
    expect(s.chat.returning).toBe(true);
    expect(setup().chat.returning).toBe(false);
  });

  it('usuário identificado manda a identidade e não manda visitor_id', async () => {
    const s = setup({
      cfg: { identity: { user_id: 'u1', hmac: 'a'.repeat(64) } },
      identified: true,
    });
    await s.chat.start();
    const body = JSON.parse(s.calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body['identity']).toEqual({ user_id: 'u1', hmac: 'a'.repeat(64) });
    expect(body).not.toHaveProperty('visitor_id');
  });

  it('falha ao abrir a sessão leva a "error" e permite tentar de novo', async () => {
    const s = setup();
    const f = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 })));
    (s.chat as unknown as { deps: { fetch: unknown } }).deps.fetch = f;
    await s.chat.start();
    expect(s.chat.state.status).toBe('error');
  });
});

describe('mensagens', () => {
  it('envio otimista é confirmado sem duplicar', async () => {
    const s = setup({ history: [msg({ from: 'visitor' })] });
    await s.chat.start();
    const p = s.chat.send('  Preciso de ajuda  ');
    expect(s.chat.state.messages.at(-1)).toMatchObject({
      content: 'Preciso de ajuda',
      pending: true,
    });
    await p;
    const list = s.chat.state.messages;
    expect(list).toHaveLength(2);
    expect(list.at(-1)?.pending).toBeUndefined();
  });

  it('falha marca a mensagem e retry reenvia com o MESMO client_message_id', async () => {
    const s = setup({ history: [msg({ from: 'visitor' })], failSend: 1 });
    await s.chat.start();
    await s.chat.send('oi');
    const failed = s.chat.state.messages.at(-1);
    expect(failed).toMatchObject({ failed: true });
    const cmid = failed?.client_message_id ?? '';
    await s.chat.retry(cmid);
    const posts = s.calls.filter((c) => c.init.method === 'POST' && c.url.endsWith('/messages'));
    expect(
      posts.map(
        (c) =>
          (JSON.parse(c.init.body as string) as { client_message_id: string }).client_message_id,
      ),
    ).toEqual([cmid, cmid]);
    expect(s.chat.state.messages.at(-1)?.failed).toBeUndefined();
    expect(s.chat.state.messages).toHaveLength(2);
  });

  it('mensagem vinda pelo socket entra uma vez só e conta como não lida com o painel fechado', async () => {
    const s = setup({ history: [msg({ from: 'visitor' })] });
    await s.chat.start();
    const m = msg({ content: 'resposta' });
    s.sockets[0]?.emit('message', m);
    s.sockets[0]?.emit('message', m);
    expect(s.chat.state.messages.filter((x) => x.id === m.id)).toHaveLength(1);
    expect(s.chat.state.unread).toBe(1);
    s.chat.setOpen(true);
    expect(s.chat.state.unread).toBe(0);
    s.sockets[0]?.emit('message', msg());
    expect(s.chat.state.unread).toBe(0); // painel aberto: já está vendo
  });

  it('texto vazio não envia', async () => {
    const s = setup({ history: [msg({ from: 'visitor' })] });
    await s.chat.start();
    await s.chat.send('   ');
    expect(s.calls.some((c) => c.init.method === 'POST' && c.url.endsWith('/messages'))).toBe(
      false,
    );
  });
});

describe('recuperação', () => {
  it('queda do socket liga o polling; ao reconectar busca o que perdeu', async () => {
    vi.useFakeTimers();
    try {
      const s = setup({ history: [msg({ from: 'visitor' })] });
      await s.chat.start();
      const sock = s.sockets[0];
      sock?.emit('ready');
      sock?.emit('disconnect', 'transport close');
      expect(s.chat.state.online).toBe(false);
      const before = s.calls.length;
      await vi.advanceTimersByTimeAsync(10_500);
      expect(s.calls.length).toBeGreaterThan(before); // polling
      const missed = msg({ content: 'chegou durante a queda' });
      // a próxima consulta devolve a resposta perdida
      (s.chat as unknown as { deps: { fetch: unknown } }).deps.fetch = () =>
        Promise.resolve(new Response(JSON.stringify({ items: [missed] }), { status: 200 }));
      sock?.emit('ready');
      await vi.advanceTimersByTimeAsync(10);
      expect(s.chat.state.messages.map((m) => m.content)).toContain('chegou durante a queda');
      expect(s.chat.state.online).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('servidor encerra a conexão (token vencido): renova a sessão e abre outro socket', async () => {
    const s = setup({ history: [msg({ from: 'visitor' })] });
    await s.chat.start();
    s.sockets[0]?.emit('disconnect', 'io server disconnect');
    await vi.waitFor(() => {
      expect(s.sockets).toHaveLength(2);
    });
  });
});
