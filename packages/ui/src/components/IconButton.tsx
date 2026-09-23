import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

const iconButton = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-(--motion-fast) ease-out disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        ghost: 'text-fg-secondary hover:bg-surface-muted',
        soft: 'bg-primary-soft text-primary-text hover:brightness-95', // botão de ligação da referência
        primary: 'rounded-control bg-primary text-on-primary hover:bg-primary-hover', // enviar (quadrado)
      },
      size: { sm: 'size-8', md: 'size-10' },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
);

export interface IconButtonProps
  extends
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'>,
    VariantProps<typeof iconButton> {
  /** Obrigatório: botão só com ícone precisa de nome acessível. */
  label: string;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, variant, size, label, icon, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(iconButton({ variant, size }), className)}
      {...rest}
    >
      <span aria-hidden className="inline-flex [&>svg]:size-5 [&>svg]:stroke-[1.5]">
        {icon}
      </span>
    </button>
  );
});
