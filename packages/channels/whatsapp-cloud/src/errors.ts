import type { ClassifiedError } from '@waychat/channels';
import { GraphError } from './graph.js';
import { UnsupportedContentError } from './send.js';

const rule = (retryable: boolean, code: string, userMessage: string): ClassifiedError => ({
  retryable,
  code,
  userMessage,
});

const RATE = rule(
  true,
  'rate_limited',
  'Limite de envio atingido; a mensagem será reenviada em instantes.',
);
const TRANSIENT = rule(
  true,
  'provider_error',
  'A Meta reportou uma falha temporária; tentaremos de novo.',
);
const AUTH = rule(
  false,
  'auth_error',
  'O token de acesso do WhatsApp expirou ou não tem permissão. Atualize-o nas configurações do canal.',
);
const INVALID = rule(false, 'invalid_request', 'Parâmetro inválido na mensagem.');
const MEDIA = rule(
  false,
  'media_error',
  'Não foi possível processar a mídia: formato ou tamanho não aceitos pelo WhatsApp.',
);

/** Códigos da documentação de erros da Cloud API → mensagem em português para o atendente. */
const BY_CODE: Record<number, ClassifiedError> = {
  131047: rule(
    false,
    'window_closed',
    'A janela de 24 horas fechou: só é possível enviar um template aprovado.',
  ),
  131026: rule(
    false,
    'undeliverable',
    'A mensagem não pôde ser entregue: o número não usa WhatsApp, está bloqueado ou não aceitou os termos.',
  ),
  131030: rule(
    false,
    'recipient_not_allowed',
    'Este número não está na lista de destinatários permitidos da conta de teste.',
  ),
  131021: rule(
    false,
    'invalid_recipient',
    'O destinatário não pode ser o próprio número da empresa.',
  ),
  131051: rule(false, 'unsupported_type', 'Este tipo de mensagem não é aceito pelo WhatsApp.'),
  131052: rule(false, 'media_error', 'Não foi possível baixar a mídia enviada pelo cliente.'),
  131053: MEDIA,
  131009: INVALID,
  100: INVALID,
  133010: rule(
    false,
    'number_not_registered',
    'O número da empresa não está registrado no WhatsApp Business.',
  ),
  132001: rule(
    false,
    'template_missing',
    'O template não existe ou não está aprovado neste idioma.',
  ),
  132012: rule(
    false,
    'template_params',
    'As variáveis do template não correspondem ao modelo aprovado.',
  ),
  132015: rule(false, 'template_paused', 'O template está pausado por baixa qualidade.'),
  132016: rule(false, 'template_disabled', 'O template foi desativado pela Meta.'),
  131048: rule(false, 'spam_limit', 'A Meta limitou os envios deste número por suspeita de spam.'),
  130429: RATE,
  131056: RATE,
  80007: RATE,
  4: RATE,
  190: AUTH,
  10: AUTH,
  131000: TRANSIENT,
  131016: TRANSIENT,
  1: TRANSIENT,
  2: TRANSIENT,
};

const codeOf = (err: unknown): number | null => {
  if (err instanceof GraphError) return err.code;
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'number')
    return err.code;
  return null;
};

/**
 * Traduz um erro do WhatsApp (webhook de status ou resposta da API) para o que o WayChat entende.
 * Desconhecido: falha de rede, 429 e HTTP 5xx valem nova tentativa; o resto não (evita reenviar o que a Meta recusou).
 */
export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof UnsupportedContentError) {
    return rule(
      false,
      'not_implemented',
      'Este tipo de mensagem ainda não é suportado para envio.',
    );
  }
  const code = codeOf(err);
  if (code !== null) {
    const known = BY_CODE[code];
    if (known) return known;
    if (code >= 200 && code < 300) return AUTH; // faixa de permissões da Graph API
  }
  if (err instanceof GraphError) {
    if (err.status === 429) return RATE;
    if (err.status === 0 || err.status >= 500)
      return rule(
        true,
        'network_error',
        'Falha de comunicação com o WhatsApp; tentaremos de novo.',
      );
    return rule(
      false,
      'provider_error',
      'O WhatsApp recusou a mensagem por um motivo não previsto.',
    );
  }
  return rule(true, 'network_error', 'Falha de comunicação com o WhatsApp; tentaremos de novo.');
}
