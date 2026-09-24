import { Bot, Check, CheckCheck, Lock, Send, AlertCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Avatar, UnreadBadge, type Presence } from './Avatar.js';
import { IconButton } from './IconButton.js';

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export interface MessageBubbleProps {
  direction: 'in' | 'out';
  /** Nome de quem enviou (mostrado acima das mensagens recebidas). */
  author?: string;
  avatarSrc?: string;
  /** Horário já formatado. */
  time: string;
  children: ReactNode;
  /** Enviada por automação/bot: mostra o ícone de robô acima da bolha. */
  automated?: boolean;
  /** "via WhatsApp", "via Widget"... */
  via?: string;
  status?: MessageStatus;
  /** Nota interna: fundo próprio e rótulo; nunca sai para o cliente. */
  note?: boolean;
  className?: string;
}

function StatusMark({ status }: { status: MessageStatus }) {
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-danger-text">
        <AlertCircle aria-hidden className="size-3.5" /> Falhou
      </span>
    );
  }
  const label = { queued: 'Enviando', sent: 'Enviada', delivered: 'Entregue', read: 'Lida' }[
    status
  ];
  const Icon = status === 'sent' || status === 'queued' ? Check : CheckCheck;
  return (
    <span
      className={cn(
        'inline-flex items-center',
        status === 'read' ? 'text-primary-text' : 'text-fg-muted',
      )}
      title={label}
    >
      <Icon aria-hidden className="size-3.5" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Bolha de mensagem (10A.5). Recebida: avatar mini + nome + horário acima, bolha branca à esquerda.
 * Enviada: horário + origem acima, à direita, bolha azul-clara. Nota interna: cartão oliva com rótulo.
 */
export function MessageBubble({
  direction,
  author,
  avatarSrc,
  time,
  children,
  automated,
  via,
  status,
  note,
  className,
}: MessageBubbleProps) {
  const out = direction === 'out';
  return (
    <div className={cn('flex flex-col gap-1.5', out ? 'items-end' : 'items-start', className)}>
      <div className="flex items-center gap-2 text-caption text-fg-muted">
        {!out && author ? (
          <>
            <Avatar name={author} src={avatarSrc} size="xs" />
            <span className="text-meta font-medium text-fg">{author}</span>
          </>
        ) : null}
        <time>{time}</time>
        {out && automated ? (
          <Bot aria-label="Enviada por automação" className="size-4 text-fg-secondary" />
        ) : null}
        {out && via ? <span className="text-meta font-medium text-fg">{via}</span> : null}
        {out && author && !via ? (
          <span className="text-meta font-medium text-fg">{author}</span>
        ) : null}
      </div>
      <div
        className={cn(
          'max-w-[min(34rem,85%)] whitespace-pre-wrap break-words rounded-card px-4 py-3 text-body text-fg',
          note ? 'bg-note' : out ? 'bg-bubble-out' : 'bg-bubble-in',
        )}
      >
        {note ? (
          <p className="mb-1 flex items-center gap-1 text-caption font-medium text-note-meta">
            <Lock aria-hidden className="size-3" /> Nota interna
          </p>
        ) : null}
        {children}
      </div>
      {out && status && !note ? <StatusMark status={status} /> : null}
    </div>
  );
}

export interface ConversationListItemProps {
  name: string;
  /** Telefone ou e-mail, em cinza abaixo do nome. */
  secondary?: string;
  preview?: string;
  /** Horário já formatado (canto direito superior). */
  time: string;
  avatarSrc?: string;
  unread?: number;
  presence?: Presence;
  selected?: boolean;
  onClick?: () => void;
}

/** Item da lista de conversas (10A.5): número de não lidas (círculo amarelo) ou presença antes do nome. */
export function ConversationListItem({
  name,
  secondary,
  preview,
  time,
  avatarSrc,
  unread = 0,
  presence,
  selected = false,
  onClick,
}: ConversationListItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-start gap-3 rounded-card p-3 text-left transition-colors duration-(--motion-fast) ease-out',
        selected ? 'bg-surface-muted' : 'hover:bg-surface-muted/60',
      )}
    >
      <Avatar name={name} src={avatarSrc} presence={presence} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {unread > 0 ? <UnreadBadge count={unread} /> : null}
          <span className="truncate text-body font-medium text-fg">{name}</span>
          <span className="ml-auto shrink-0 text-caption text-fg-muted">{time}</span>
        </span>
        {secondary ? (
          <span className="block truncate text-meta text-fg-secondary">{secondary}</span>
        ) : null}
        {preview ? (
          <span className="mt-0.5 block truncate text-meta text-fg">{preview}</span>
        ) : null}
      </span>
    </button>
  );
}

export interface CannedItem {
  shortcut: string;
  content: string;
}

export interface ComposerProps {
  /** Devolve `true` se aceitou (limpa o campo). O envio real é responsabilidade de quem usa. */
  onSend: (text: string, mode: 'reply' | 'note') => boolean | Promise<boolean>;
  canned?: CannedItem[];
  disabled?: boolean;
  placeholder?: string;
  /** Rótulo do canal ("WhatsApp", "Widget") exibido no chip. */
  channelLabel?: string;
  /** Avisa que o atendente está (ou parou de) digitando; quem usa aplica o limite de taxa. */
  onTyping?: (on: boolean) => void;
}

/**
 * Compositor (10A.5): cartão branco com sombra, alternância Responder / Nota interna, `/` abre respostas prontas,
 * Enter envia e Shift+Enter quebra linha.
 */
export function Composer({
  onSend,
  canned = [],
  disabled,
  placeholder,
  channelLabel,
  onTyping,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const suggestions = useMemo(() => {
    if (!text.startsWith('/') || text.includes(' ')) return [];
    const q = text.slice(1).toLowerCase();
    return canned.filter((c) => c.shortcut.startsWith(q)).slice(0, 6);
  }, [text, canned]);

  useEffect(() => {
    setActive(0);
  }, [suggestions.length]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${String(Math.min(el.scrollHeight, 160))}px`;
  }, [text]);

  const pick = (c: CannedItem) => {
    setText(c.content);
    ref.current?.focus();
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || busy || disabled) return;
    setBusy(true);
    try {
      if (await onSend(value, mode)) {
        setText('');
        onTyping?.(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const c = suggestions[active];
        if (c) pick(c);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const note = mode === 'note';
  return (
    <div className={cn('relative rounded-card p-3 shadow-soft', note ? 'bg-note' : 'bg-surface')}>
      {suggestions.length > 0 ? (
        <ul
          role="listbox"
          aria-label="Respostas prontas"
          className="absolute bottom-full left-0 mb-2 w-full max-w-md overflow-hidden rounded-card bg-surface p-1 shadow-soft"
        >
          {suggestions.map((c, i) => (
            <li key={c.shortcut} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                className={cn(
                  'flex w-full flex-col rounded-control px-3 py-2 text-left',
                  i === active ? 'bg-surface-muted' : '',
                )}
              >
                <span className="text-meta font-medium text-primary-text">/{c.shortcut}</span>
                <span className="truncate text-meta text-fg-secondary">{c.content}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mb-2 flex items-center gap-2" role="tablist" aria-label="Tipo de mensagem">
        {(
          [
            ['reply', 'Responder'],
            ['note', 'Nota interna'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => {
              setMode(value);
            }}
            className={cn(
              'rounded-control px-3 py-1 text-meta font-medium transition-colors duration-(--motion-fast)',
              mode === value ? 'bg-surface-muted text-fg' : 'text-fg-secondary hover:text-fg',
            )}
          >
            {label}
          </button>
        ))}
        {channelLabel && !note ? (
          <span className="ml-auto rounded-control bg-surface-muted px-2.5 py-1 text-caption text-fg-secondary">
            {channelLabel}
          </span>
        ) : null}
      </div>
      <div className="flex items-end gap-3">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          disabled={disabled}
          aria-label={note ? 'Escrever nota interna' : 'Escrever mensagem'}
          placeholder={
            placeholder ??
            (note
              ? 'Nota visível só para a equipe…'
              : 'Digite sua mensagem… (/ para respostas prontas)')
          }
          onChange={(e) => {
            setText(e.target.value);
            if (mode === 'reply' && e.target.value.trim()) onTyping?.(true);
          }}
          onBlur={() => {
            onTyping?.(false);
          }}
          onKeyDown={onKey}
          className="max-h-40 min-h-10 flex-1 resize-none bg-transparent py-2 text-body text-fg placeholder:text-fg-muted focus:outline-none"
        />
        <IconButton
          variant="primary"
          label={note ? 'Salvar nota' : 'Enviar mensagem'}
          icon={<Send />}
          disabled={disabled || busy || text.trim().length === 0}
          onClick={() => void submit()}
        />
      </div>
    </div>
  );
}
