export type Locale = 'pt-BR' | 'en' | 'es';

const dict = {
  'pt-BR': {
    open: 'Abrir chat',
    close: 'Fechar chat',
    welcome: 'Olá! Como podemos ajudar?',
    prechatTitle: 'Antes de começar',
    name: 'Seu nome',
    email: 'Seu e-mail',
    start: 'Iniciar conversa',
    placeholder: 'Escreva sua mensagem',
    send: 'Enviar',
    reconnecting: 'Reconectando…',
    failed: 'Não enviada. Tentar de novo',
    agent: 'Atendente',
    you: 'Você',
    error: 'Não foi possível conectar. Tente novamente em instantes.',
    retry: 'Tentar de novo',
  },
  en: {
    open: 'Open chat',
    close: 'Close chat',
    welcome: 'Hi! How can we help?',
    prechatTitle: 'Before we start',
    name: 'Your name',
    email: 'Your email',
    start: 'Start conversation',
    placeholder: 'Write your message',
    send: 'Send',
    reconnecting: 'Reconnecting…',
    failed: 'Not sent. Try again',
    agent: 'Agent',
    you: 'You',
    error: 'Could not connect. Please try again shortly.',
    retry: 'Try again',
  },
  es: {
    open: 'Abrir chat',
    close: 'Cerrar chat',
    welcome: '¡Hola! ¿En qué podemos ayudarte?',
    prechatTitle: 'Antes de empezar',
    name: 'Tu nombre',
    email: 'Tu correo',
    start: 'Iniciar conversación',
    placeholder: 'Escribe tu mensaje',
    send: 'Enviar',
    reconnecting: 'Reconectando…',
    failed: 'No enviado. Reintentar',
    agent: 'Agente',
    you: 'Tú',
    error: 'No fue posible conectar. Inténtalo de nuevo en unos instantes.',
    retry: 'Reintentar',
  },
} as const;

export type Strings = Record<keyof (typeof dict)['pt-BR'], string>;

/** Aceita "pt", "pt-BR", "en-US", "es-MX"...; qualquer outra coisa cai em português. */
export function pickLocale(pref: string | undefined | null): Locale {
  const p = (pref ?? '').toLowerCase();
  if (p.startsWith('en')) return 'en';
  if (p.startsWith('es')) return 'es';
  return 'pt-BR';
}

export const strings = (l: Locale): Strings => dict[l];
