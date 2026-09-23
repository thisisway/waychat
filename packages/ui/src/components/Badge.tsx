import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

const badge = cva('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-meta font-medium', {
  variants: {
    tone: {
      // "Respondido" / "Aguardando" na referência
      warning: 'bg-warning-bg text-warning-text',
      neutral: 'bg-surface-muted text-fg-secondary',
      success: 'bg-primary-soft text-primary-text',
    },
  },
  defaultVariants: { tone: 'warning' },
});

const dot: Record<'warning' | 'neutral' | 'success', string> = {
  warning: 'bg-warning-dot',
  neutral: 'bg-offline',
  success: 'bg-success',
};

export interface BadgeProps extends VariantProps<typeof badge> {
  children: ReactNode;
  className?: string;
}

/** Status da conversa: ponto colorido + texto (a cor nunca é a única informação). */
export function Badge({ tone = 'warning', children, className }: BadgeProps) {
  return (
    <span className={cn(badge({ tone }), className)}>
      <span aria-hidden className={cn('size-1.5 rounded-full', dot[tone ?? 'warning'])} />
      {children}
    </span>
  );
}

export interface ChipProps {
  children: ReactNode;
  emoji?: string;
  /** Com `onRemove` aparece o "×" da referência (tags no painel lateral). */
  onRemove?: () => void;
  className?: string;
}

export function Chip({ children, emoji, onRemove, className }: ChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-control bg-surface-muted px-2.5 py-1 text-meta text-fg',
        className,
      )}
    >
      {emoji ? <span aria-hidden>{emoji}</span> : null}
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remover"
          className="rounded-full p-0.5 text-fg-secondary hover:bg-hairline"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </span>
  );
}
