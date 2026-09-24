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
  attachments: [],
  ...over,
});

interface Setup {
  chat: Chat;
  sockets: FakeSocket[];
  calls: { url: string; init: RequestInit }[];
  store: Map<string, string>;
  uploads: { url: string; fields: Record<string, string>; file: File }[];
}

function setup(
  opts: {
    cfg?: Partial<ChatConfig>;
    history?: Msg[];
    identified?: boolean;
    store?: Map<string, string>;
    failSend?: number;
    uploadOk?: boolean;
    /** Status devolvido por /complete. */
    completeStatus?: 'clean' | 'scanning';
    /** Quantas consultas a /url devolvem 404 antes de liberar. */
    notCleanPolls?: number;
  } = {},
): Setup {
  const sockets: FakeSocket[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const store = opts.store ?? new Map<string, string>();
  const uploads: Setup['uploads'] = [];
  let failSend = opts.failSend ?? 0;
  let urlPolls = 0;
  let attSeq = 0;
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
    if (url.endsWith('/widget/v1/attachments') && init.method === 'POST') {
      const b = JSON.parse(init.body as string) as { file_name: string; size: number };
      attSeq++;
      return json(
        {
          attachment: {
            id: `att-${String(attSeq)}`,
            file_name: b.file_name,
            content_type: 'image/png',
            size: b.size,
            status: 'pending',
          },
          upload: { url: 'https://s3.test/bucket', fields: { key: 'k', policy: 'p' } },
        },
        201,
      );
    }
    if (url.endsWith('/complete')) {
      return json({ attachment: { id: 'x', status: opts.completeStatus ?? 'scanning' } });
    }
    if (/\/attachments\/[^/]+\/url$/.test(url)) {
      urlPolls++;
      return urlPolls > (opts.notCleanPolls ?? 0)
        ? json({ url: 'https://s3.test/signed' })
        : json({ error: { code: 'not_found', message: 'x' } }, 404);
    }
    if (url.endsWith('/widget/v1/messages') && init.method === 'POST') {
      if (failSend > 0) {
        failSend--;
        return json({}, 500);
      }
      const b = JSON.parse(init.body as string) as {
        content: string;
        client_message_id: string;
        attachment_ids?: string[];
      };
      return json({
        message: msg({
          from: 'visitor',
          content: b.content,
          client_message_id: b.client_message_id,
          attachments: (b.attachment_ids ?? []).map((id) => ({
            id,
            file_name: 'foto.png',
            content_type: 'image/png',
            size: 1,
          })),
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
    uploadFile: (url, fields, file) => {
      uploads.push({ url, fields, file });
      return Promise.resolve(opts.uploadOk ?? true);
    },
  };
  const chat = new Chat({ api: 'https://api.test', publicKey: 'ibx_x', ...opts.cfg }, deps);
  return { chat, sockets, calls, store, uploads };
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

const png = (name = 'foto.png') => new File(['x'], name, { type: 'image/png' });
const attCalls = (s: Setup, suffix: string) => s.calls.filter((c) => c.url.endsWith(suffix));
const postedMessages = (s: Setup) =>
  s.calls.filter((c) => c.init.method === 'POST' && c.url.endsWith('/widget/v1/messages'));

describe('anexos', () => {
  it('fluxo feliz: pede upload, envia ao S3, conclui, espera o antivírus e envia com attachment_ids', async () => {
    const s = setup({ notCleanPolls: 2 });
    await s.chat.start();
    vi.useFakeTimers();
    try {
      const p = s.chat.attach(png());
      await vi.advanceTimersByTimeAsync(10);
      expect(s.chat.state.draft[0]).toMatchObject({ status: 'scanning', attachmentId: 'att-1' });
      // o S3 recebe os campos assinados e o arquivo
      expect(s.uploads).toHaveLength(1);
      expect(s.uploads[0]).toMatchObject({
        url: 'https://s3.test/bucket',
        fields: { key: 'k', policy: 'p' },
      });
      expect(s.uploads[0]?.file.name).toBe('foto.png');
      await vi.advanceTimersByTimeAsync(3500);
      await p;
      expect(s.chat.state.draft[0]).toMatchObject({ status: 'ready', attachmentId: 'att-1' });
      expect(attCalls(s, '/url')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
    await s.chat.send('');
    const body = JSON.parse(postedMessages(s)[0]?.init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ content: '', attachment_ids: ['att-1'] });
    expect(s.chat.state.draft).toEqual([]);
    expect(s.chat.state.messages.at(-1)?.attachments.map((a) => a.id)).toEqual(['att-1']);
  });

  it('anexo já limpo no complete vai direto para pronto, sem polling', async () => {
    const s = setup({ completeStatus: 'clean' });
    await s.chat.start();
    await s.chat.attach(png());
    expect(s.chat.state.draft[0]?.status).toBe('ready');
    expect(attCalls(s, '/url')).toHaveLength(0);
  });

  it('extensão proibida e arquivo > 10 MB são barrados no cliente, sem chamar a API', async () => {
    const s = setup();
    await s.chat.start();
    const before = s.calls.length;
    await s.chat.attach(new File(['x'], 'virus.exe'));
    await s.chat.attach(new File(['x'], 'semextensao'));
    await s.chat.attach(new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'grande.pdf'));
    expect(s.chat.state.draft.map((d) => [d.status, d.error])).toEqual([
      ['error', 'type'],
      ['error', 'type'],
      ['error', 'size'],
    ]);
    expect(s.calls.length).toBe(before);
    expect(s.uploads).toHaveLength(0);
  });

  it('falha no upload ao S3 marca erro e não conclui', async () => {
    const s = setup({ uploadOk: false });
    await s.chat.start();
    await s.chat.attach(png());
    expect(s.chat.state.draft[0]).toMatchObject({ status: 'error', error: 'upload' });
    expect(attCalls(s, '/complete')).toHaveLength(0);
  });

  it('no máximo 5 anexos por mensagem', async () => {
    const s = setup({ completeStatus: 'clean' });
    await s.chat.start();
    await Promise.all(Array.from({ length: 6 }, (_, i) => s.chat.attach(png(`f${String(i)}.png`))));
    expect(s.chat.state.draft).toHaveLength(5);
    expect(s.calls.filter((c) => c.url.endsWith('/widget/v1/attachments'))).toHaveLength(5);
  });

  it('send não dispara enquanto há anexo em verificação', async () => {
    const s = setup();
    await s.chat.start();
    vi.useFakeTimers();
    try {
      const p = s.chat.attach(png());
      await vi.advanceTimersByTimeAsync(10);
      expect(s.chat.state.draft[0]?.status).toBe('scanning');
      await s.chat.send('oi');
      expect(postedMessages(s)).toHaveLength(0);
      expect(s.chat.state.draft).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1500);
      await p;
    } finally {
      vi.useRealTimers();
    }
    await s.chat.send('oi');
    expect(postedMessages(s)).toHaveLength(1);
  });

  it('desiste da verificação após ~60 s', async () => {
    const s = setup({ notCleanPolls: Infinity });
    await s.chat.start();
    vi.useFakeTimers();
    try {
      const p = s.chat.attach(png());
      await vi.advanceTimersByTimeAsync(61_000);
      await p;
      expect(s.chat.state.draft[0]).toMatchObject({ status: 'error', error: 'scan' });
      expect(attCalls(s, '/url')).toHaveLength(60);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remover do rascunho interrompe o polling', async () => {
    const s = setup();
    await s.chat.start();
    vi.useFakeTimers();
    try {
      const p = s.chat.attach(png());
      await vi.advanceTimersByTimeAsync(10);
      const id = s.chat.state.draft[0]?.localId ?? '';
      s.chat.removeDraft(id);
      expect(s.chat.state.draft).toEqual([]);
      await vi.advanceTimersByTimeAsync(3000);
      await p;
      expect(attCalls(s, '/url')).toHaveLength(0);
      expect(s.chat.state.draft).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('downloadUrl devolve o link assinado', async () => {
    const s = setup();
    await s.chat.start();
    await expect(s.chat.downloadUrl('att-9')).resolves.toBe('https://s3.test/signed');
  });
});
