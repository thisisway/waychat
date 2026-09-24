const hm = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dm = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const full = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** Hoje: "14:32". Outros dias: "23/09". */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return sameDay(d, now) ? hm.format(d) : dm.format(d);
}

/** Dentro da conversa sempre há o horário; outro dia acrescenta a data: "23/09 14:32". */
export function messageTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return sameDay(d, now) ? hm.format(d) : `${dm.format(d)} ${hm.format(d)}`;
}

export const fullDate = (iso: string): string => full.format(new Date(iso));

export const STATUS_LABEL = {
  open: 'Aberta',
  pending: 'Aguardando',
  snoozed: 'Adiada',
  resolved: 'Resolvida',
} as const;

export const STATUS_TONE = {
  open: 'success',
  pending: 'warning',
  snoozed: 'neutral',
  resolved: 'neutral',
} as const;
