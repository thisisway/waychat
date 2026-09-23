import { cva, type VariantProps } from 'class-variance-authority';
import { useState } from 'react';
import { cn } from '../lib/cn.js';

const avatar = cva(
  'relative inline-flex shrink-0 items-center justify-center rounded-full bg-avatar font-semibold text-on-avatar select-none',
  {
    variants: {
      size: {
        xs: 'size-5 text-[9px]', // mini ao lado do nome na mensagem
        md: 'size-10 text-meta',
        lg: 'size-12 text-body', // cartão de contato
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export type Presence = 'online' | 'offline';

export interface AvatarProps extends VariantProps<typeof avatar> {
  name: string;
  src?: string | undefined;
  /** Bolinha de presença. O estado também é dito a leitores de tela. */
  presence?: Presence;
  className?: string;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function Avatar({ name, src, size, presence, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;
  return (
    <span className={cn(avatar({ size }), className)} role="img" aria-label={name}>
      {showImage ? (
        <img
          src={src}
          alt=""
          className="size-full rounded-full object-cover"
          onError={() => {
            setFailed(true);
          }}
        />
      ) : (
        <span aria-hidden>{initials(name)}</span>
      )}
      {presence ? (
        <>
          <span
            aria-hidden
            className={cn(
              'absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-surface',
              presence === 'online' ? 'bg-success' : 'bg-offline',
            )}
          />
          <span className="sr-only">{presence === 'online' ? 'online' : 'offline'}</span>
        </>
      ) : null}
    </span>
  );
}

/** Círculo amarelo com a contagem de não lidas (o número usa --text, como na referência). */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="inline-flex size-5 items-center justify-center rounded-full bg-unread text-caption font-semibold text-on-unread"
      aria-label={`${String(count)} não lidas`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
