import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';

/** Envolve a aplicação uma vez: define o atraso padrão (abre rápido, fecha sem "piscar"). */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={300} skipDelayDuration={150}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  /** Um único elemento focável; ele é o gatilho (também abre com o foco do teclado). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/** Dica escura da referência ("Usar template"): fundo --tooltip-bg, texto branco, cantos de 10px. */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-control bg-tooltip px-3 py-1.5 text-meta text-on-tooltip shadow-soft"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
