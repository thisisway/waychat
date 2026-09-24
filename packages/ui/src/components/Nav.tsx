import type { ComponentType, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

type IconType = ComponentType<{ className?: string }>;

export interface SidebarNavItemProps {
  icon: IconType;
  label: string;
  count?: number | undefined;
  active?: boolean;
  onClick?: () => void;
}

/**
 * Item da sidebar de filtros. Ativo: ícone branco dentro de um quadrado azul (com sombra azulada),
 * rótulo e contador em azul. A barra vertical azul na borda da sidebar é responsabilidade do contêiner.
 */
export function SidebarNavItem({
  icon: Icon,
  label,
  count,
  active = false,
  onClick,
}: SidebarNavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-control px-2 py-2 text-left text-body font-medium transition-colors duration-(--motion-fast) ease-out',
        active ? 'text-primary-text' : 'text-fg hover:bg-surface-muted',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-flex size-9 shrink-0 items-center justify-center rounded-control',
          active ? 'bg-primary text-on-primary shadow-active' : 'text-fg-secondary',
        )}
      >
        <Icon className="size-5 stroke-[1.5]" />
      </span>
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span
          className={cn('text-meta font-normal', active ? 'text-primary-text' : 'text-fg-muted')}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

export interface TopNavTabProps {
  icon: IconType;
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
}

/** Aba da barra superior: ativa em azul com sublinhado de 3px arredondado. */
export function TopNavTab({ icon: Icon, children, active = false, onClick }: TopNavTabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex items-center gap-2 px-3 py-6 text-body font-medium transition-colors duration-(--motion-fast) ease-out',
        active ? 'text-primary-text' : 'text-fg hover:text-primary-text',
      )}
    >
      <Icon
        className={cn('size-5 stroke-[1.5]', active ? 'text-primary-text' : 'text-fg-secondary')}
      />
      {children}
      {active ? (
        <span aria-hidden className="absolute inset-x-3 bottom-0 h-[3px] rounded-full bg-primary" />
      ) : null}
    </button>
  );
}
