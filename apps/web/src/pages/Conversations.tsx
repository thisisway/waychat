import { Navigate, useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  Accordion,
  AccordionSection,
  Avatar,
  Badge,
  Button,
  Chip,
  Composer,
  ConversationListItem,
  IconButton,
  InfoCard,
  MessageBubble,
  NoteCard,
  Search,
  SidebarNavItem,
  TopNavTab,
  setTheme,
} from '@waychat/ui';
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Inbox,
  LogOut,
  MessageSquare,
  Moon,
  RotateCcw,
  Sun,
  UserCheck,
  UserRound,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, post } from '../api.js';
import {
  makeTypingNotifier,
  startRealtime,
  useConversationPresence,
  useRealtimeStatus,
} from '../realtime.js';
import { fullDate, messageTime, shortTime, STATUS_LABEL, STATUS_TONE } from '../format.js';
import {
  useCanned,
  useConversation,
  useConversations,
  useCounts,
  useLabels,
  useMarkRead,
  useMe,
  useMessages,
  useSendMessage,
  useToggleLabel,
  useUpdateConversation,
} from '../queries.js';
import { ACCEPT, openAttachment, useAttachmentDrafts } from '../attachments.js';
import type { ConversationDetail, FilterKey, Me, Message } from '../types.js';

const FILTERS: { key: FilterKey; label: string; icon: typeof Inbox }[] = [
  { key: 'unassigned', label: 'Não atribuídas', icon: UserRound },
  { key: 'mine', label: 'Atribuídas a mim', icon: UserCheck },
  { key: 'all', label: 'Todas', icon: MessageSquare },
];

export function ConversationsPage() {
  const me = useMe();
  const search = useSearch({ from: '/' });
  const nav = useNavigate();
  const qc = useQueryClient();
  const loggedIn = me.isSuccess;

  useEffect(() => {
    if (!loggedIn) return;
    return startRealtime(qc, () => {
      qc.clear();
      void nav({ to: '/login' });
    });
  }, [loggedIn, qc, nav]);

  if (me.isPending)
    return (
      <div className="grid h-full place-items-center bg-app text-fg-secondary">Carregando…</div>
    );
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" />;
    return (
      <div className="grid h-full place-items-center bg-app text-danger-text">
        Não foi possível carregar.
      </div>
    );
  }
  const user = me.data;
  const selectedId = search.c;

  const logout = async () => {
    try {
      await post('/auth/logout');
    } finally {
      qc.clear();
      await nav({ to: '/login' });
    }
  };

  return (
    <div className="h-full bg-shell">
      <div className="flex h-full flex-col overflow-hidden bg-shell">
        <TopBar me={user} onLogout={() => void logout()} />
        <div className="flex min-h-0 flex-1 gap-3 p-0 lg:p-3">
          <Sidebar
            filter={search.f}
            onFilter={(f) => void nav({ to: '/', search: { f, c: undefined } })}
          />
          <ConversationList
            filter={search.f}
            selectedId={selectedId}
            onSelect={(id) => void nav({ to: '/', search: { f: search.f, c: id } })}
            hiddenOnMobile={!!selectedId}
          />
          {selectedId ? (
            <ConversationView
              key={selectedId}
              id={selectedId}
              me={user}
              onBack={() => void nav({ to: '/', search: { f: search.f, c: undefined } })}
            />
          ) : (
            <EmptyState />
          )}
        </div>
      </div>
    </div>
  );
}

function TopBar({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [dark, setDark] = useState(document.documentElement.dataset['theme'] === 'dark');
  return (
    <header className="flex h-16 shrink-0 items-center gap-4 bg-surface px-4 lg:h-20 lg:px-8">
      <span className="text-title font-semibold text-fg">WayChat</span>
      <ConnectionBadge />
      <nav aria-label="Principal" className="ml-2 flex flex-1 lg:ml-8">
        <TopNavTab icon={MessageSquare} active>
          Conversas
        </TopNavTab>
      </nav>
      <IconButton
        label={dark ? 'Ativar tema claro' : 'Ativar tema escuro'}
        icon={dark ? <Sun /> : <Moon />}
        onClick={() => {
          setTheme(dark ? 'light' : 'dark');
          setDark(!dark);
        }}
      />
      <div className="hidden items-center gap-3 border-l border-hairline pl-4 sm:flex">
        <Avatar name={me.user.name} />
        <div className="leading-tight">
          <p className="text-body font-medium text-fg">{me.user.name}</p>
          <p className="text-caption text-fg-secondary">{me.account.name}</p>
        </div>
      </div>
      <IconButton label="Sair" icon={<LogOut />} onClick={onLogout} />
    </header>
  );
}

/** Só aparece quando a conexão em tempo real cai por mais de 3 s (evita piscar em quedas curtas). */
function ConnectionBadge() {
  const status = useRealtimeStatus();
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (status === 'online') {
      setLate(false);
      return;
    }
    const t = setTimeout(() => {
      setLate(true);
    }, 3000);
    return () => {
      clearTimeout(t);
    };
  }, [status]);
  if (status === 'online' || !late) return null;
  return (
    <span
      role="status"
      className="hidden rounded-full bg-warning-bg px-3 py-1 text-caption font-medium text-warning-text sm:inline"
    >
      Reconectando…
    </span>
  );
}

function Sidebar({ filter, onFilter }: { filter: FilterKey; onFilter: (f: FilterKey) => void }) {
  const counts = useCounts();
  const count = (k: FilterKey) => counts.data?.[k];
  return (
    <aside
      aria-label="Filtros"
      className="relative hidden w-60 shrink-0 flex-col rounded-panel bg-surface p-3 lg:flex"
    >
      {FILTERS.map(({ key, label, icon }) => (
        <SidebarNavItem
          key={key}
          icon={icon}
          label={label}
          count={count(key)}
          active={filter === key}
          onClick={() => {
            onFilter(key);
          }}
        />
      ))}
    </aside>
  );
}

function ConversationList({
  filter,
  selectedId,
  onSelect,
  hiddenOnMobile,
}: {
  filter: FilterKey;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  hiddenOnMobile: boolean;
}) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(term.trim());
    }, 250);
    return () => {
      clearTimeout(t);
    };
  }, [term]);
  const list = useConversations({ filter, search: debounced });
  const items = list.data?.items ?? [];
  const unread = items.filter((c) => c.unreadCount > 0);
  const rest = items.filter((c) => c.unreadCount === 0);
  const [openUnread, setOpenUnread] = useState(true);
  const [openAll, setOpenAll] = useState(true);

  const row = (c: (typeof items)[number]) => (
    <li key={c.id}>
      <ConversationListItem
        name={c.contact.name}
        secondary={c.contact.phone ?? c.contact.email ?? `#${String(c.displayId)}`}
        preview={c.lastMessage ?? ''}
        time={shortTime(c.lastActivityAt)}
        unread={c.unreadCount}
        selected={c.id === selectedId}
        onClick={() => {
          onSelect(c.id);
        }}
      />
    </li>
  );

  const section = (
    title: string,
    n: number,
    open: boolean,
    toggle: () => void,
    children: React.ReactNode,
  ) => (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-2 text-left text-body font-medium text-fg"
      >
        <ChevronRight
          aria-hidden
          className={`size-4 text-fg-secondary transition-transform ${open ? 'rotate-90' : ''}`}
        />
        {title} <span className="text-meta font-normal text-fg-muted">{n}</span>
      </button>
      {open ? <ul className="flex flex-col gap-1">{children}</ul> : null}
    </section>
  );

  return (
    <section
      aria-label="Conversas"
      className={`${hiddenOnMobile ? 'hidden lg:flex' : 'flex'} min-h-0 w-full shrink-0 flex-col gap-2 bg-surface p-3 lg:w-[22rem] lg:rounded-panel`}
    >
      <Search
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
        }}
        placeholder="Buscar conversas…"
      />
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {list.isError ? (
          <p className="p-3 text-meta text-danger-text">Não foi possível carregar as conversas.</p>
        ) : null}
        {list.isSuccess && items.length === 0 ? (
          <p className="p-6 text-center text-meta text-fg-secondary">
            {debounced ? 'Nada encontrado para essa busca.' : 'Nenhuma conversa aqui.'}
          </p>
        ) : null}
        {unread.length > 0
          ? section(
              'Não lidas',
              unread.length,
              openUnread,
              () => {
                setOpenUnread(!openUnread);
              },
              unread.map(row),
            )
          : null}
        {rest.length > 0
          ? section(
              unread.length > 0 ? 'Demais conversas' : 'Todas as mensagens',
              rest.length,
              openAll,
              () => {
                setOpenAll(!openAll);
              },
              rest.map(row),
            )
          : null}
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-panel bg-chat p-6 text-center lg:flex">
      <MessageSquare aria-hidden className="size-10 text-fg-muted" />
      <p className="text-body font-medium text-fg">Selecione uma conversa</p>
      <p className="text-meta text-fg-secondary">As mensagens dos seus clientes aparecem aqui.</p>
    </div>
  );
}

function ConversationView({ id, me, onBack }: { id: string; me: Me; onBack: () => void }) {
  const conv = useConversation(id);
  const messages = useMessages(id);
  const canned = useCanned();
  const markRead = useMarkRead();
  const update = useUpdateConversation(id);
  const send = useSendMessage(id, me);
  const files = useAttachmentDrafts(id);
  const endRef = useRef<HTMLDivElement>(null);
  const presence = useConversationPresence(id);
  const notifyTyping = useMemo(() => makeTypingNotifier(id), [id]);

  const ordered = useMemo(() => [...(messages.data?.items ?? [])].reverse(), [messages.data]);
  const unread = conv.data?.unreadCount ?? 0;

  useEffect(() => {
    if (unread > 0 && !markRead.isPending) markRead.mutate(id);
    // marca como lida quando aparece mensagem nova enquanto a conversa está aberta
  }, [unread, id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [ordered.length, files.drafts.length]); // chips do rascunho encolhem a lista: rola de novo para o fim

  if (conv.isError) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 rounded-panel bg-chat p-6">
        <p className="text-body text-fg">Conversa não encontrada.</p>
        <Button variant="outline" onClick={onBack}>
          Voltar
        </Button>
      </div>
    );
  }
  const c = conv.data;

  return (
    <>
      <section
        aria-label="Conversa"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-chat lg:rounded-panel"
      >
        <ConversationHeader c={c} me={me} onBack={onBack} update={update} />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-20 lg:px-8">
          {messages.isPending ? (
            <p className="text-meta text-fg-secondary">Carregando mensagens…</p>
          ) : null}
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {ordered.map((m) => (
              <Bubble
                key={m.clientMessageId ?? m.id}
                m={m}
                contactName={c?.contact.name ?? ''}
                channel={c?.inbox.name}
                meId={me.user.id}
              />
            ))}
            <div ref={endRef} />
          </div>
        </div>
        <div className="mx-auto w-full max-w-3xl px-4 pb-4 lg:px-8">
          {presence.typing ? (
            <p role="status" className="mb-2 text-meta text-fg-secondary">
              Outro atendente está digitando…
            </p>
          ) : presence.others > 0 ? (
            <p role="status" className="mb-2 text-meta text-fg-secondary">
              {presence.others === 1
                ? 'Outro atendente está'
                : `${String(presence.others)} atendentes estão`}{' '}
              nesta conversa.
            </p>
          ) : null}
          {send.isError ? (
            <p role="alert" className="mb-2 text-meta text-danger-text">
              {send.error instanceof ApiError ? send.error.message : 'Não foi possível enviar.'}
            </p>
          ) : null}
          <Composer
            canned={canned.data?.items ?? []}
            {...(c ? { channelLabel: c.inbox.name } : {})}
            onTyping={notifyTyping}
            disabled={!c}
            drafts={files.drafts}
            onAttach={files.attach}
            onRemoveDraft={files.remove}
            accept={ACCEPT}
            onSend={async (text, mode) => {
              try {
                const attach =
                  mode === 'reply' ? files.drafts.filter((d) => d.status === 'ready') : [];
                await send.mutateAsync({
                  content: text,
                  private: mode === 'note',
                  clientMessageId: crypto.randomUUID(),
                  attachments: attach,
                });
                if (attach.length > 0) files.clear();
                return true;
              } catch {
                return false; // mantém o texto no campo para tentar de novo
              }
            }}
          />
        </div>
      </section>
      {c ? <InfoPanel c={c} messages={ordered} /> : null}
    </>
  );
}

function ConversationHeader({
  c,
  me,
  onBack,
  update,
}: {
  c: ConversationDetail | undefined;
  me: Me;
  onBack: () => void;
  update: ReturnType<typeof useUpdateConversation>;
}) {
  const assignee = !c?.assigneeId
    ? 'Sem responsável'
    : c.assigneeId === me.user.id
      ? 'Você'
      : 'Outro atendente';
  const resolved = c?.status === 'resolved';
  return (
    <header className="absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 bg-surface/70 px-4 py-3 backdrop-blur-md lg:rounded-t-panel lg:px-6">
      <IconButton
        className="lg:hidden"
        label="Voltar para a lista"
        icon={<ArrowLeft />}
        onClick={onBack}
      />
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate text-body font-medium text-fg">{c?.contact.name ?? '…'}</p>
        <p className="truncate text-meta text-fg-secondary">
          Responsável: <span className="text-fg">{assignee}</span>
        </p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {c && c.assigneeId !== me.user.id ? (
          <Button
            variant="ghost"
            loading={update.isPending}
            onClick={() => {
              update.mutate({ assignee_id: me.user.id });
            }}
          >
            Assumir
          </Button>
        ) : null}
        {c ? (
          <Button
            variant="outline"
            loading={update.isPending}
            onClick={() => {
              update.mutate({ status: resolved ? 'open' : 'resolved' });
            }}
          >
            {resolved ? (
              <RotateCcw className="size-4" aria-hidden />
            ) : (
              <CheckCircle2 className="size-4" aria-hidden />
            )}
            {resolved ? 'Reabrir' : 'Marcar como resolvida'}
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function Bubble({
  m,
  contactName,
  channel,
  meId,
}: {
  m: Message;
  contactName: string;
  channel: string | undefined;
  meId: string;
}) {
  const out = m.direction === 'out';
  return (
    <MessageBubble
      direction={out ? 'out' : 'in'}
      time={messageTime(m.createdAt)}
      {...(out ? {} : { author: contactName })}
      {...(out && m.senderId !== meId ? { author: 'Equipe' } : {})}
      {...(out && channel ? { via: `via ${channel}` } : {})}
      {...(out ? { status: m.status } : {})}
      note={m.private}
      automated={m.senderType === 'bot'}
      attachments={m.attachments.map((a) => ({ id: a.id, name: a.fileName, size: a.size }))}
      onOpenAttachment={(attId) => {
        void openAttachment(attId);
      }}
    >
      {m.content}
    </MessageBubble>
  );
}

function InfoPanel({ c, messages }: { c: ConversationDetail; messages: Message[] }) {
  const labels = useLabels();
  const toggle = useToggleLabel(c.id);
  const [picking, setPicking] = useState(false);
  const notes = messages.filter((m) => m.private);
  const available = (labels.data?.items ?? []).filter((l) => !c.labels.some((x) => x.id === l.id));
  return (
    <aside
      aria-label="Informações gerais"
      className="hidden w-80 shrink-0 flex-col gap-4 overflow-y-auto rounded-panel bg-surface p-4 xl:flex"
    >
      <h2 className="text-title font-semibold text-fg">Informações gerais</h2>
      <InfoCard
        name={c.contact.name}
        {...(c.contact.phone ? { phone: c.contact.phone } : {})}
        status={{ label: STATUS_LABEL[c.status], tone: STATUS_TONE[c.status] }}
      />
      <dl className="flex flex-col gap-3 text-meta">
        {c.contact.email ? (
          <div>
            <dt className="font-medium text-fg">E-mail</dt>
            <dd className="text-fg-secondary">{c.contact.email}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-medium text-fg">Data de criação</dt>
          <dd className="text-fg-secondary">{fullDate(c.createdAt)}</dd>
        </div>
        <div>
          <dt className="font-medium text-fg">Caixa de entrada</dt>
          <dd className="text-fg-secondary">{c.inbox.name}</dd>
        </div>
        <div>
          <dt className="font-medium text-fg">Conversa</dt>
          <dd>
            <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>{' '}
            <span className="text-fg-secondary">#{c.displayId}</span>
          </dd>
        </div>
      </dl>
      <Accordion type="multiple" defaultValue={['notas', 'tags']}>
        <AccordionSection value="notas" title="Notas" count={notes.length}>
          <div className="flex flex-col gap-2">
            {notes.length === 0 ? (
              <p className="text-meta text-fg-secondary">Nenhuma nota interna.</p>
            ) : null}
            {notes.map((n) => (
              <NoteCard key={n.id} meta={messageTime(n.createdAt)}>
                {n.content}
              </NoteCard>
            ))}
          </div>
        </AccordionSection>
        <AccordionSection
          value="tags"
          title="Tags"
          count={c.labels.length}
          action={
            available.length > 0 ? (
              <button
                type="button"
                className="text-meta font-medium text-primary-text"
                onClick={() => {
                  setPicking(!picking);
                }}
              >
                Adicionar
              </button>
            ) : undefined
          }
        >
          <div className="flex flex-wrap gap-2">
            {c.labels.map((l) => (
              <Chip
                key={l.id}
                onRemove={() => {
                  toggle.mutate({ labelId: l.id, on: false });
                }}
              >
                {l.name}
              </Chip>
            ))}
            {c.labels.length === 0 ? (
              <p className="text-meta text-fg-secondary">Sem tags.</p>
            ) : null}
          </div>
          {picking ? (
            <ul className="mt-2 flex flex-wrap gap-2" aria-label="Tags disponíveis">
              {available.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    className="rounded-control bg-primary-soft px-2.5 py-1 text-meta text-primary-text"
                    onClick={() => {
                      toggle.mutate({ labelId: l.id, on: true });
                      setPicking(false);
                    }}
                  >
                    + {l.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </AccordionSection>
      </Accordion>
    </aside>
  );
}
