import type { Socket } from 'socket.io-client';

export interface Msg {
  id: string;
  from: 'visitor' | 'agent';
  content: string;
  created_at: string;
  client_message_id: string | null;
  /** Enviada localmente, ainda sem confirmação da API. */
  pending?: boolean;
  failed?: boolean;
}

export interface InboxInfo {
  name: string;
  welcome_message: string | null;
  primary_color: string | null;
}

export interface ChatConfig {
  /** Origem da API (ex.: https://chat.exemplo.com). */
  api: string;
  publicKey: string;
  /** Usuário logado no site do cliente; o HMAC é gerado no servidor DELE. */
  identity?: { user_id: string; hmac: string };
}

export interface ChatState {
  status: 'idle' | 'connecting' | 'ready' | 'error';
  /** Tempo real conectado. */
  online: boolean;
  messages: Msg[];
  inbox: InboxInfo | null;
  /** Precisa de nome/e-mail (pré-chat) antes de a conversa começar. */
  needsProfile: boolean;
  unread: number;
}

interface Session {
  token: string;
  expires_at: string;
  visitor_id: string | null;
  identified: boolean;
  inbox: InboxInfo;
}

export interface ChatDeps {
  fetch: typeof fetch;
  connect: (url: string, token: string) => Socket;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  uuid: () => string;
}

interface Profile {
  name: string;
  email: string;
}

const POLL_MS = 10_000;

/**
 * Tudo que não é tela: sessão, histórico, envio otimista, tempo real e recuperação.
 * A UI só lê `state` e chama `open()`, `send()` e `submitProfile()`.
 */
export class Chat {
  state: ChatState = {
    status: 'idle',
    online: false,
    messages: [],
    inbox: null,
    needsProfile: false,
    unread: 0,
  };
  private listeners = new Set<() => void>();
  private token: string | null = null;
  private visitorId: string | null = null;
  private profile: Profile | null = null;
  private socket: Socket | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private opening: Promise<void> | null = null;
  private panelOpen = false;
  private destroyed = false;

  constructor(
    private readonly cfg: ChatConfig,
    private readonly deps: ChatDeps,
  ) {
    this.visitorId = this.read('visitor');
    const p = this.read('profile');
    if (p) {
      try {
        this.profile = JSON.parse(p) as Profile;
      } catch {
        this.profile = null;
      }
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Quem já conversou antes (ou está identificado) conecta ao carregar, para mostrar respostas não lidas. */
  get returning(): boolean {
    return Boolean(this.visitorId ?? this.cfg.identity);
  }

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private key(name: string): string {
    return `waychat:${this.cfg.publicKey}:${name}`;
  }
  private read(name: string): string | null {
    try {
      return this.deps.storage?.getItem(this.key(name)) ?? null;
    } catch {
      return null;
    }
  }
  private write(name: string, value: string): void {
    try {
      this.deps.storage?.setItem(this.key(name), value);
    } catch {
      // armazenamento bloqueado (navegação privada): o visitante perde só a continuidade entre visitas
    }
  }

  private async req<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const res = await this.deps.fetch(`${this.cfg.api}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok)
      throw Object.assign(new Error(`http_${String(res.status)}`), { status: res.status });
    return (await res.json()) as T;
  }

  /** Abre (ou reabre) a sessão e o tempo real. Chamadas simultâneas compartilham a mesma tentativa. */
  start(): Promise<void> {
    this.opening ??= this.connect().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connect(): Promise<void> {
    if (this.destroyed) return;
    this.set({ status: 'connecting' });
    try {
      const s = await this.req<Session>('/widget/v1/session', {
        method: 'POST',
        body: JSON.stringify({
          public_key: this.cfg.publicKey,
          ...(this.cfg.identity ? { identity: this.cfg.identity } : {}),
          ...(!this.cfg.identity && this.visitorId ? { visitor_id: this.visitorId } : {}),
          ...(this.profile ?? {}),
        }),
      });
      this.token = s.token;
      if (s.visitor_id) {
        this.visitorId = s.visitor_id;
        this.write('visitor', s.visitor_id);
      }
      const history = await this.req<{ items: Msg[] }>('/widget/v1/messages', {}, s.token);
      this.set({
        status: 'ready',
        inbox: s.inbox,
        messages: history.items,
        // pré-chat só para quem nunca falou e não se identificou
        needsProfile: !s.identified && !this.profile && history.items.length === 0,
      });
      this.openSocket(s.token);
    } catch {
      this.set({ status: 'error' });
    }
  }

  private openSocket(token: string): void {
    this.socket?.off();
    this.socket?.disconnect();
    const socket = this.deps.connect(`${this.cfg.api}/widget`, token);
    this.socket = socket;
    let first = true;
    socket.on('ready', () => {
      this.set({ online: true });
      this.stopPolling();
      // reconexão: pode ter chegado resposta enquanto estava fora
      if (!first) void this.refresh();
      first = false;
    });
    socket.on('message', (m: Msg) => {
      this.add(m);
    });
    socket.on('disconnect', (reason: string) => {
      this.set({ online: false });
      this.startPolling();
      // o servidor encerra a conexão quando o token vence: renova a sessão em vez de ficar mudo
      if (reason === 'io server disconnect') void this.start();
    });
    socket.on('connect_error', () => {
      this.set({ online: false });
      this.startPolling();
    });
  }

  private startPolling(): void {
    this.poll ??= setInterval(() => void this.refresh(), POLL_MS);
  }
  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private async refresh(): Promise<void> {
    if (!this.token) return;
    try {
      const h = await this.req<{ items: Msg[] }>('/widget/v1/messages', {}, this.token);
      for (const m of h.items) this.add(m);
    } catch (e) {
      if ((e as { status?: number }).status === 401) await this.start();
    }
  }

  /** Insere sem duplicar: por id, ou pelo `client_message_id` quando confirma uma mensagem otimista. */
  private add(m: Msg): void {
    const list = this.state.messages;
    const i = list.findIndex(
      (x) => x.id === m.id || (m.client_message_id && x.client_message_id === m.client_message_id),
    );
    if (i >= 0) {
      const next = [...list];
      next[i] = m;
      this.set({ messages: next });
      return;
    }
    this.set({
      messages: [...list, m],
      unread: m.from === 'agent' && !this.panelOpen ? this.state.unread + 1 : this.state.unread,
    });
  }

  /** O painel abriu/fechou: abrir zera as não lidas e garante que a sessão existe. */
  setOpen(open: boolean): void {
    this.panelOpen = open;
    if (open) {
      this.set({ unread: 0 });
      if (this.state.status === 'idle' || this.state.status === 'error') void this.start();
    }
  }

  async submitProfile(name: string, email: string): Promise<void> {
    this.profile = { name: name.trim(), email: email.trim() };
    this.write('profile', JSON.stringify(this.profile));
    this.set({ needsProfile: false });
    await this.start(); // a sessão nova leva nome/e-mail (ficam no contato na primeira mensagem)
  }

  async send(text: string, reuseId?: string): Promise<void> {
    const content = text.trim();
    if (!content || !this.token) return;
    const clientMessageId = reuseId ?? this.deps.uuid();
    const optimistic: Msg = {
      id: `local-${clientMessageId}`,
      from: 'visitor',
      content,
      created_at: new Date().toISOString(),
      client_message_id: clientMessageId,
      pending: true,
    };
    if (reuseId) {
      this.set({
        messages: this.state.messages.map((m) =>
          m.client_message_id === reuseId ? { ...m, pending: true, failed: false } : m,
        ),
      });
    } else {
      this.add(optimistic);
    }
    try {
      const res = await this.req<{ message: Msg }>(
        '/widget/v1/messages',
        { method: 'POST', body: JSON.stringify({ content, client_message_id: clientMessageId }) },
        this.token,
      );
      this.add(res.message);
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        await this.start();
        return this.send(content, clientMessageId);
      }
      this.set({
        messages: this.state.messages.map((m) =>
          m.client_message_id === clientMessageId ? { ...m, pending: false, failed: true } : m,
        ),
      });
    }
  }

  /** Reenvia uma mensagem que falhou (mesmo `client_message_id`: se a primeira chegou, não duplica). */
  retry(clientMessageId: string): Promise<void> {
    const m = this.state.messages.find((x) => x.client_message_id === clientMessageId);
    return m ? this.send(m.content, clientMessageId) : Promise.resolve();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPolling();
    this.socket?.off();
    this.socket?.disconnect();
    this.listeners.clear();
  }
}
