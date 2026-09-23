import { Search as SearchIcon } from 'lucide-react';
import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn.js';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Mensagem de erro: liga o campo ao texto via aria-describedby e marca aria-invalid. */
  error?: string;
}

const field =
  'h-10 w-full rounded-control bg-surface-input px-3 text-body text-fg placeholder:text-fg-muted transition-colors duration-(--motion-fast) disabled:opacity-50 aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-danger';

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, error, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const errorId = `${inputId}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={inputId} className="text-meta font-medium text-fg">
          {label}
        </label>
      ) : null}
      <input
        ref={ref}
        id={inputId}
        className={cn(field, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
      {error ? (
        <p id={errorId} className="text-meta text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
});

/** Campo de busca (lista de conversas): ícone à esquerda, mesmo fundo dos inputs. */
export const Search = forwardRef<HTMLInputElement, Omit<InputProps, 'label' | 'error' | 'type'>>(
  function Search({ className, placeholder = 'Buscar...', ...rest }, ref) {
    return (
      <div className="relative">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 stroke-[1.5] text-fg-secondary"
        />
        <input
          ref={ref}
          type="search"
          role="searchbox"
          placeholder={placeholder}
          aria-label={rest['aria-label'] ?? placeholder}
          className={cn(field, 'pl-10', className)}
          {...rest}
        />
      </div>
    );
  },
);
