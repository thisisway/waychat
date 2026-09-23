import { Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Avatar } from './Avatar.js';
import { Badge } from './Badge.js';
import { IconButton } from './IconButton.js';

export interface NoteCardProps {
  children: ReactNode;
  /** Data/autor já formatados. */
  meta: string;
  className?: string;
}

/** Nota interna (painel lateral e linha do tempo): fundo oliva claro, data em tom mais discreto. */
export function NoteCard({ children, meta, className }: NoteCardProps) {
  return (
    <article className={cn('rounded-card bg-note p-4', className)}>
      <p className="text-body text-fg">{children}</p>
      <p className="mt-2 text-caption text-note-meta">{meta}</p>
    </article>
  );
}

export interface InfoCardProps {
  name: string;
  phone?: string;
  avatarSrc?: string;
  status?: { label: string; tone?: 'warning' | 'neutral' | 'success' };
  onCall?: () => void;
  className?: string;
}

/** Cartão de contato do topo do painel "Informações gerais". */
export function InfoCard({ name, phone, avatarSrc, status, onCall, className }: InfoCardProps) {
  return (
    <section
      aria-label={`Contato ${name}`}
      className={cn('rounded-card bg-surface-info p-4', className)}
    >
      <div className="flex items-start justify-between gap-3">
        <Avatar name={name} src={avatarSrc} size="lg" />
        {status ? <Badge tone={status.tone ?? 'warning'}>{status.label}</Badge> : null}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-fg">{name}</p>
          {phone ? <p className="text-meta text-fg-secondary">{phone}</p> : null}
        </div>
        {onCall ? (
          <IconButton
            variant="soft"
            label={`Ligar para ${name}`}
            icon={<Phone />}
            onClick={onCall}
          />
        ) : null}
      </div>
    </section>
  );
}
