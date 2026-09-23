import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = { title: 'Fundamentos' } satisfies Meta;
export default meta;

const COLORS = [
  ['app', 'Fundo externo'],
  ['shell', 'Moldura'],
  ['surface', 'Superfície'],
  ['surface-muted', 'Item selecionado / chip'],
  ['surface-input', 'Campo'],
  ['surface-info', 'Cartão de contato'],
  ['chat', 'Área de mensagens'],
  ['bubble-in', 'Bolha recebida'],
  ['bubble-out', 'Bolha enviada'],
  ['primary', 'Primário'],
  ['primary-soft', 'Primário suave'],
  ['note', 'Nota interna'],
  ['warning-bg', 'Aviso'],
  ['unread', 'Não lidas'],
  ['success', 'Online'],
  ['danger', 'Perigo'],
  ['avatar', 'Avatar (iniciais)'],
  ['tooltip', 'Tooltip'],
] as const;

export const Cores: StoryObj = {
  render: () => (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {COLORS.map(([token, label]) => (
        <div key={token} className="overflow-hidden rounded-card bg-surface shadow-soft">
          <div
            className="h-14 border-b border-hairline"
            style={{ background: `var(--color-${token})` }}
          />
          <div className="p-3">
            <p className="text-meta font-medium text-fg">{label}</p>
            <p className="text-caption text-fg-muted">{token}</p>
          </div>
        </div>
      ))}
    </div>
  ),
};

export const Tipografia: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-3 rounded-panel bg-surface p-6">
      <p className="text-title font-semibold text-fg">
        Informações gerais — título de painel 20/600
      </p>
      <p className="text-body font-medium text-fg">Brandon Madsen — nomes e itens de menu 15/500</p>
      <p className="text-body text-fg">
        O horário de atendimento termina às 18h — texto de mensagem 15/400
      </p>
      <p className="text-meta text-fg-secondary">
        +55 11 90000-0000 · m.brandon@exemplo.com — metadados 13/400
      </p>
      <p className="text-caption text-fg-muted">11:18 · 39 — horários e contadores 12/400</p>
    </div>
  ),
};

export const FormasESombras: StoryObj = {
  render: () => (
    <div className="flex flex-wrap items-end gap-4">
      {(
        [
          ['shell', '32px'],
          ['panel', '20px'],
          ['card', '16px'],
          ['control', '10px'],
        ] as const
      ).map(([name, px]) => (
        <div
          key={name}
          className="grid size-24 place-items-center bg-surface text-meta text-fg shadow-soft"
          style={{ borderRadius: `var(--radius-${name})` }}
        >
          {px}
        </div>
      ))}
    </div>
  ),
};
