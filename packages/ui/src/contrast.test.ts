// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

/** Lê as variáveis de um bloco de seletor. O tema escuro herda do claro o que não redefinir. */
function tokens(selectorStart: string): Record<string, string> {
  const start = css.indexOf(selectorStart);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open, close).matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
    out[m[1] as string] = m[2] as string;
  }
  return out;
}

const light = tokens(':root,');
const dark = { ...light, ...tokens("[data-theme='dark'] {") };

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [texto, fundo, mínimo]. 4.5 = texto normal (AA); 3 = componente de interface/ícone (WCAG 1.4.11). */
const PAIRS: [string, string, number][] = [
  ['text', 'surface', 4.5],
  ['text', 'surface-muted', 4.5],
  ['text', 'surface-input', 4.5],
  ['text', 'surface-info', 4.5],
  ['text', 'chat-bg', 4.5],
  ['text', 'bg-shell', 4.5],
  ['text', 'bubble-in', 4.5],
  ['text', 'bubble-out', 4.5],
  ['text', 'note-bg', 4.5],
  ['text-secondary', 'surface', 4.5],
  ['text-secondary', 'surface-muted', 4.5],
  ['text-secondary', 'surface-input', 4.5],
  ['text-secondary', 'surface-info', 4.5],
  ['text-secondary', 'chat-bg', 4.5],
  ['text-secondary', 'bubble-in', 4.5],
  ['text-muted', 'surface', 4.5],
  ['text-muted', 'surface-muted', 4.5],
  ['text-muted', 'surface-input', 4.5],
  ['text-muted', 'surface-info', 4.5],
  ['text-muted', 'chat-bg', 4.5],
  ['text-muted', 'bubble-in', 4.5],
  ['primary-text', 'surface', 4.5],
  ['primary-text', 'surface-muted', 4.5],
  ['primary-text', 'surface-info', 4.5],
  ['primary-text', 'chat-bg', 4.5],
  ['primary-text', 'primary-soft', 4.5],
  ['on-primary', 'primary', 4.5],
  ['on-primary', 'primary-hover', 4.5],
  ['danger-text', 'surface', 4.5],
  ['danger-text', 'chat-bg', 4.5],
  ['warning-text', 'warning-bg', 4.5],
  ['note-meta', 'note-bg', 4.5],
  ['on-tooltip', 'tooltip-bg', 4.5],
  ['on-avatar', 'avatar-fallback', 4.5],
  ['on-unread', 'unread', 4.5],
  // não-texto (indicadores, ícones ativos)
  ['primary', 'surface', 3],
  ['success', 'surface', 3],
  ['danger', 'surface', 3],
];

describe.each([
  ['claro', light],
  ['escuro', dark],
])('contraste WCAG AA — tema %s', (_name, theme) => {
  it.each(PAIRS)('%s sobre %s ≥ %s', (fg, bg, min) => {
    const f = theme[fg];
    const b = theme[bg];
    expect(f, `token --${fg} ausente`).toBeDefined();
    expect(b, `token --${bg} ausente`).toBeDefined();
    const r = ratio(f as string, b as string);
    expect(
      r,
      `${fg} ${f as string} sobre ${bg} ${b as string} = ${r.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(min);
  });
});

describe('tokens', () => {
  it('os dois temas definem as mesmas chaves de cor essenciais', () => {
    for (const key of [
      'bg-app',
      'surface',
      'text',
      'primary',
      'bubble-in',
      'bubble-out',
      'chat-bg',
    ]) {
      expect(dark[key]).toBeDefined();
    }
    expect(dark['bubble-out']).toBe('#16335f'); // valores do tema escuro definidos no prompt
    expect(dark['surface']).toBe('#1b1f26');
    expect(dark['text']).toBe('#e8eaed');
  });

  it('usa os valores de referência do tema claro que passam no AA', () => {
    expect(light['primary']).toBe('#1560ff');
    expect(light['bubble-out']).toBe('#cae7fb');
    expect(light['bg-app']).toBe('#c1cada');
  });
});
