export type Theme = 'light' | 'dark';
const KEY = 'waychat-theme';

/** Preferência salva (toggle "Modo escuro") ou, na falta dela, a do sistema. */
export function resolveTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage pode estar bloqueado (modo privado): cai na preferência do sistema
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // ignorado: o tema vale só nesta sessão
  }
}

/** Chame antes da primeira pintura (script inline no index.html) para evitar o "flash" do tema errado. */
export function initTheme(): Theme {
  const theme = resolveTheme();
  applyTheme(theme);
  return theme;
}
