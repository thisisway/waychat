import * as RadixAccordion from '@radix-ui/react-accordion';
import { ChevronRight } from 'lucide-react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

/** Seções recolhíveis do painel lateral ("Campanhas", "Notas", "Tags"...): separadas por linhas finíssimas. */
export function Accordion(props: ComponentPropsWithoutRef<typeof RadixAccordion.Root>) {
  return <RadixAccordion.Root {...props} />;
}

export interface AccordionSectionProps {
  value: string;
  title: string;
  /** Contador ao lado do título (ex.: quantidade de notas). */
  count?: number;
  /** Ação à direita (ex.: link "Adicionar"). Fora do gatilho para não aninhar botões. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function AccordionSection({
  value,
  title,
  count,
  action,
  children,
  className,
}: AccordionSectionProps) {
  return (
    <RadixAccordion.Item value={value} className={cn('border-b border-hairline', className)}>
      <div className="flex items-center justify-between gap-2">
        <RadixAccordion.Header className="flex-1">
          <RadixAccordion.Trigger className="group flex w-full items-center gap-2 py-4 text-left text-body font-medium text-fg">
            <ChevronRight
              aria-hidden
              className="size-4 shrink-0 text-fg-secondary transition-transform duration-(--motion-base) ease-out group-data-[state=open]:rotate-90"
            />
            <span>{title}</span>
            {count !== undefined ? (
              <span className="text-meta font-normal text-fg-muted">{count}</span>
            ) : null}
          </RadixAccordion.Trigger>
        </RadixAccordion.Header>
        {action}
      </div>
      <RadixAccordion.Content className="overflow-hidden pb-4 data-[state=closed]:hidden">
        {children}
      </RadixAccordion.Content>
    </RadixAccordion.Item>
  );
}
