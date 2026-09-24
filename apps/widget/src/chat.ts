import type { Socket } from 'socket.io-client';

export interface AttachmentInfo {
  id: string;
  file_name: string;
  content_type: string;
  size: number;
}

export type DraftError = 'type' | 'size' | 'upload' | 'scan';

/** Anexo em preparação (ainda não enviado numa mensagem). */
export interface DraftItem {
  localId: string;
  name: string;
  size: number;
  status: 'uploading' | 'scanning' | 'ready' | 'error';
  attachmentId?: string;
  error?: DraftError;
}

export interface Msg {
  id: string;
  from: 'visitor' | 'agent';
  content: string;
  created_at: string;
  client_message_id: string | null;
  attachments: AttachmentInfo[];
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
  draft: DraftItem[];
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
  /** Envia o arquivo direto ao armazenamento (POST multipart com os campos assinados). true = 2xx. */
  uploadFile: (url: string, fields: Record<string, string>, file: File) => Promise<boolean>;
}

interface Profile {
  name: string;
  email: string;
}

const POLL_MS = 10_000;

/** Mesmos limites do servidor; validar aqui só evita uma ida à API. */
export const ATTACH_EXT = [
  ...['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a'],
  ...['mp4', 'mov', 'webm', 'txt', 'csv', 'log'],
];
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACH_PER_MSG = 5;
const SCAN_MS = 1000;
const SCAN_TRIES = 60;

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
    draft: [],
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

  /** `retryAtt` só vem de `retry()`: reenvia os anexos que já estavam na mensagem. */
  async send(text: string, reuseId?: string, retryAtt?: AttachmentInfo[]): Promise<void> {
    const content = text.trim();
    const draft = this.state.draft;
    if (!reuseId && draft.some((d) => d.status === 'uploading' || d.status === 'scanning')) return;
    const atts: AttachmentInfo[] =
      retryAtt ??
      draft.flatMap((d) =>
        d.status === 'ready' && d.attachmentId
          ? [{ id: d.attachmentId, file_name: d.name, content_type: '', size: d.size }]
          : [],
      );
    if ((!content && atts.length === 0) || !this.token) return;
    const clientMessageId = reuseId ?? this.deps.uuid();
    const optimistic: Msg = {
      id: `local-${clientMessageId}`,
      from: 'visitor',
      content,
      created_at: new Date().toISOString(),
      client_message_id: clientMessageId,
      attachments: atts,
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
      this.set({ draft: draft.filter((d) => d.status !== 'ready') });
    }
    try {
      const res = await this.req<{ message: Msg }>(
        '/widget/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            content,
            client_message_id: clientMessageId,
            attachment_ids: atts.map((a) => a.id),
          }),
        },
        this.token,
      );
      this.add(res.message);
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        await this.start();
        return this.send(content, clientMessageId, atts);
      }
      this.set({
        messages: this.state.messages.map((m) =>
          m.client_message_id === clientMessageId ? { ...m, pending: false, failed: true } : m,
        ),
      });
    }
  }

  /** Requisição autenticada; em 401 renova a sessão e repete uma vez. */
  private async authed<T>(path: string, init: RequestInit = {}): Promise<T> {
    try {
      return await this.req<T>(path, init, this.token ?? undefined);
    } catch (e) {
      if ((e as { status?: number }).status !== 401) throw e;
      await this.start();
      return this.req<T>(path, init, this.token ?? undefined);
    }
  }

  private patchDraft(localId: string, patch: Partial<DraftItem>): void {
    this.set({
      draft: this.state.draft.map((d) => (d.localId === localId ? { ...d, ...patch } : d)),
    });
  }

  removeDraft(localId: string): void {
    this.set({ draft: this.state.draft.filter((d) => d.localId !== localId) });
  }

  /** Valida, pede o upload, envia ao S3, conclui e espera o antivírus liberar. */
  async attach(file: File): Promise<void> {
    if (this.state.draft.length >= MAX_ATTACH_PER_MSG) return;
    const localId = this.deps.uuid();
    const dot = file.name.lastIndexOf('.');
    const ext = dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase();
    const item: DraftItem = { localId, name: file.name, size: file.size, status: 'uploading' };
    const invalid: DraftError | null = !ATTACH_EXT.includes(ext)
      ? 'type'
      : file.size > MAX_ATTACH_BYTES
        ? 'size'
        : null;
    // o rascunho entra antes de qualquer await: vários arquivos de uma vez respeitam o limite
    this.set({
      draft: [...this.state.draft, invalid ? { ...item, status: 'error', error: invalid } : item],
    });
    if (invalid) return;
    try {
      const r = await this.authed<{
        attachment: { id: string };
        upload: { url: string; fields: Record<string, string> };
      }>('/widget/v1/attachments', {
        method: 'POST',
        body: JSON.stringify({ file_name: file.name, size: file.size }),
      });
      const id = r.attachment.id;
      this.patchDraft(localId, { attachmentId: id });
      if (!(await this.deps.uploadFile(r.upload.url, r.upload.fields, file))) {
        this.patchDraft(localId, { status: 'error', error: 'upload' });
        return;
      }
      const c = await this.authed<{ attachment: { status: string } }>(
        `/widget/v1/attachments/${id}/complete`,
        { method: 'POST', body: '{}' },
      );
      if (c.attachment.status === 'clean') {
        this.patchDraft(localId, { status: 'ready' });
        return;
      }
      this.patchDraft(localId, { status: 'scanning' });
      await this.waitClean(localId, id);
    } catch {
      this.patchDraft(localId, { status: 'error', error: 'upload' });
    }
  }

  /** Sonda a URL de download: 200 = antivírus liberou. Desiste em ~60 s. */
  private async waitClean(localId: string, id: string): Promise<void> {
    for (let i = 0; i < SCAN_TRIES; i++) {
      await new Promise((r) => setTimeout(r, SCAN_MS));
      if (this.destroyed || !this.state.draft.some((d) => d.localId === localId)) return;
      try {
        await this.authed(`/widget/v1/attachments/${id}/url`);
        this.patchDraft(localId, { status: 'ready' });
        return;
      } catch {
        // 404 = ainda em verificação; tenta de novo
      }
    }
    this.patchDraft(localId, { status: 'error', error: 'scan' });
  }

  /** Link assinado (5 min): peça no clique, não antes. */
  async downloadUrl(attachmentId: string): Promise<string> {
    return (await this.authed<{ url: string }>(`/widget/v1/attachments/${attachmentId}/url`)).url;
  }

  /** Reenvia uma mensagem que falhou (mesmo `client_message_id`: se a primeira chegou, não duplica). */
  retry(clientMessageId: string): Promise<void> {
    const m = this.state.messages.find((x) => x.client_message_id === clientMessageId);
    return m ? this.send(m.content, clientMessageId, m.attachments) : Promise.resolve();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPolling();
    this.socket?.off();
    this.socket?.disconnect();
    this.listeners.clear();
  }
}
