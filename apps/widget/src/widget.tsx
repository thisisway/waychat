import { useEffect, useRef, useState } from 'preact/hooks';
import type { Chat, ChatState } from './chat.js';
import type { Strings } from './i18n.js';

const ICON_CHAT = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.6-.8L3 21l1.9-5.4A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" />
  </svg>
);
const ICON_X = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

function useChat(chat: Chat): ChatState {
  const [state, setState] = useState(chat.state);
  useEffect(
    () =>
      chat.subscribe(() => {
        setState(chat.state);
      }),
    [chat],
  );
  return state;
}

const time = (iso: string, locale: string) =>
  new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

interface Props {
  chat: Chat;
  t: Strings;
  locale: string;
  color?: string;
}

export function Widget({ chat, t, locale, color }: Props) {
  const state = useChat(chat);
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);

  const toggle = (next: boolean) => {
    setOpen(next);
    chat.setOpen(next);
    if (!next) launcher.current?.focus();
  };
  const primary = state.inbox?.primary_color ?? color;

  return (
    <div
      class="wc"
      style={primary ? { '--primary': primary, '--primary-hover': primary } : undefined}
    >
      {open ? (
        <Panel
          chat={chat}
          state={state}
          t={t}
          locale={locale}
          onClose={() => {
            toggle(false);
          }}
        />
      ) : null}
      <button
        ref={launcher}
        class="launcher"
        type="button"
        aria-label={open ? t.close : t.open}
        aria-expanded={open}
        onClick={() => {
          toggle(!open);
        }}
      >
        {open ? ICON_X : ICON_CHAT}
        {!open && state.unread > 0 ? <span class="badge">{state.unread}</span> : null}
      </button>
    </div>
  );
}

function Panel({
  chat,
  state,
  t,
  locale,
  onClose,
}: {
  chat: Chat;
  state: ChatState;
  t: Strings;
  locale: string;
  onClose: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [state.messages.length]);
  useEffect(() => {
    first.current?.focus();
  }, [state.needsProfile, state.status]);

  return (
    <section
      class="panel"
      role="dialog"
      aria-label={state.inbox?.name ?? t.open}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <header class="head">
        <span class="dot" aria-hidden="true" />
        <h2>{state.inbox?.name ?? ''}</h2>
        <button type="button" aria-label={t.close} onClick={onClose}>
          {ICON_X}
        </button>
      </header>
      {state.status === 'ready' && !state.online ? (
        <div class="status" role="status">
          {t.reconnecting}
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div class="error" role="alert">
          <span>{t.error}</span>
          <button
            class="primary"
            type="button"
            onClick={() => {
              void chat.start();
            }}
          >
            {t.retry}
          </button>
        </div>
      ) : state.needsProfile ? (
        <PreChat
          t={t}
          onSubmit={(n, e) => {
            void chat.submitProfile(n, e);
          }}
          focusRef={first}
        />
      ) : (
        <>
          <div ref={list} class="list" role="log" aria-live="polite" aria-label={state.inbox?.name}>
            {state.inbox && state.messages.length === 0 ? (
              <div class="welcome">{state.inbox.welcome_message ?? t.welcome}</div>
            ) : null}
            {state.messages.map((m) => (
              <div key={m.id} class={`msg ${m.from}${m.pending ? ' pending' : ''}`}>
                {m.content}
                <span class="meta">
                  {m.from === 'agent' ? `${t.agent} · ` : ''}
                  {time(m.created_at, locale)}
                  {m.failed && m.client_message_id ? (
                    <>
                      {' · '}
                      <button
                        class="retry"
                        type="button"
                        onClick={() => {
                          void chat.retry(m.client_message_id ?? '');
                        }}
                      >
                        {t.failed}
                      </button>
                    </>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          <Composer
            t={t}
            disabled={state.status !== 'ready'}
            onSend={(text) => {
              void chat.send(text);
            }}
            focusRef={first}
          />
        </>
      )}
    </section>
  );
}

type FocusRef = { current: HTMLElement | null };

function PreChat({
  t,
  onSubmit,
  focusRef,
}: {
  t: Strings;
  onSubmit: (name: string, email: string) => void;
  focusRef: FocusRef;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  return (
    <form
      class="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(name, email);
      }}
    >
      <h3>{t.prechatTitle}</h3>
      <label>
        {t.name}
        <input
          ref={(el) => {
            focusRef.current = el;
          }}
          required
          maxLength={200}
          autoComplete="name"
          value={name}
          onInput={(e) => {
            setName(e.currentTarget.value);
          }}
        />
      </label>
      <label>
        {t.email}
        <input
          required
          type="email"
          maxLength={320}
          autoComplete="email"
          value={email}
          onInput={(e) => {
            setEmail(e.currentTarget.value);
          }}
        />
      </label>
      <button class="primary" type="submit">
        {t.start}
      </button>
    </form>
  );
}

function Composer({
  t,
  disabled,
  onSend,
  focusRef,
}: {
  t: Strings;
  disabled: boolean;
  onSend: (text: string) => void;
  focusRef: FocusRef;
}) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim() || disabled) return;
    onSend(text);
    setText('');
  };
  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={(el) => {
          focusRef.current = el;
        }}
        rows={1}
        maxLength={10000}
        aria-label={t.placeholder}
        placeholder={t.placeholder}
        value={text}
        onInput={(e) => {
          setText(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button class="primary" type="submit" disabled={disabled || !text.trim()}>
        {t.send}
      </button>
    </form>
  );
}
