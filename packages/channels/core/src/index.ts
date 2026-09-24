import type { Readable } from 'node:stream';

/**
 * Contrato dos canais externos (seção 8.4 do prompt). O núcleo do WayChat só conhece estes tipos: tudo o que é
 * específico de um provedor (Meta, Telegram...) fica dentro do adaptador.
 */

export type ChannelType = 'whatsapp';

/** Requisição HTTP crua do webhook: a assinatura é calculada sobre os BYTES originais, nunca sobre o JSON reparseado. */
export interface RawRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  rawBody: Buffer;
}

/** Configuração decifrada da inbox (segredos incluídos). Cada adaptador valida a sua. */
export type InboxConfig = Record<string, unknown>;

// ---------- entrada normalizada ----------

/** Mídia que o provedor guarda por um tempo curto: precisa ser baixada logo (`downloadMedia`). */
export interface MediaRef {
  id: string;
  mimeType: string;
  sha256?: string;
  fileName?: string;
}

export type InboundContent =
  | { type: 'text'; body: string }
  | {
      type: 'image' | 'video' | 'document' | 'sticker';
      media: MediaRef;
      caption?: string;
      animated?: boolean;
    }
  | { type: 'audio'; media: MediaRef; voice: boolean }
  | { type: 'location'; latitude: number; longitude: number; name?: string; address?: string }
  | { type: 'contacts'; contacts: SharedContact[] }
  | { type: 'reaction'; targetProviderId: string; emoji: string | null }
  | { type: 'button_reply' | 'list_reply'; replyId: string; title: string; description?: string }
  /** Resposta rápida de um botão de template. */
  | { type: 'button'; text: string; payload: string }
  /** Tipo que o provedor não entrega (ou que ainda não tratamos): guardamos o motivo para o atendente ver. */
  | { type: 'unsupported'; providerType: string; detail?: string };

export interface SharedContact {
  name: string;
  phones: { phone: string; waId?: string; kind?: string }[];
  emails: string[];
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface ProviderError {
  code: number;
  title: string;
  message: string;
  details?: string;
}

export type NormalizedEvent =
  | {
      kind: 'message';
      /** Id da mensagem no provedor (wamid): chave de deduplicação. */
      providerId: string;
      /** Phone Number ID que recebeu: confere com o da inbox (webhook de outra conta é ignorado). */
      accountRef: string;
      from: { id: string; name?: string };
      at: Date;
      /** Mensagem que está sendo respondida (citação). */
      replyToProviderId?: string;
      content: InboundContent;
    }
  | {
      kind: 'status';
      providerId: string;
      accountRef: string;
      status: DeliveryStatus;
      recipientId: string;
      at: Date;
      /** Valor que enviamos em `biz_opaque_callback_data` (nosso id de mensagem). */
      opaque?: string;
      error?: ProviderError;
    }
  | {
      kind: 'template_status';
      /** Id da conta comercial (WABA): o webhook de template não traz o número. */
      wabaId: string;
      providerTemplateId: string;
      name: string;
      language: string;
      status: 'approved' | 'rejected' | 'pending' | 'paused' | 'disabled' | 'other';
      reason?: string;
    }
  | {
      kind: 'quality';
      wabaId: string;
      displayPhone: string;
      event: string;
      tier?: string;
    };

// ---------- saída ----------

export type OutboundMedia = { id: string } | { link: string };

export type OutboundContent =
  | { type: 'text'; body: string; previewUrl?: boolean }
  | {
      type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
      media: OutboundMedia;
      caption?: string;
      fileName?: string;
      voice?: boolean;
    }
  | { type: 'location'; latitude: number; longitude: number; name?: string; address?: string }
  | { type: 'contacts'; contacts: SharedContact[] }
  | { type: 'reaction'; targetProviderId: string; emoji: string | null }
  | {
      type: 'interactive_buttons';
      body: string;
      buttons: { id: string; title: string }[];
      header?: string;
      footer?: string;
    }
  | {
      type: 'interactive_list';
      body: string;
      buttonLabel: string;
      sections: { title: string; rows: { id: string; title: string; description?: string }[] }[];
      header?: string;
      footer?: string;
    }
  | {
      type: 'interactive_cta_url';
      body: string;
      label: string;
      url: string;
      header?: string;
      footer?: string;
    }
  | { type: 'template'; name: string; language: string; components: TemplateComponentValues[] };

/** Valores das variáveis de um template já preenchidos. */
export interface TemplateComponentValues {
  type: 'header' | 'body' | 'button';
  parameters: (
    | { type: 'text'; text: string }
    | { type: 'image' | 'video' | 'document'; media: OutboundMedia; fileName?: string }
    | { type: 'payload'; payload: string }
  )[];
  /** Só botões: posição e tipo. */
  index?: number;
  subType?: 'quick_reply' | 'url';
}

export interface OutboundMessage {
  /** Destinatário no formato do provedor (WhatsApp: número com DDI, só dígitos). */
  to: string;
  content: OutboundContent;
  replyToProviderId?: string;
  /** Nosso id de mensagem; o provedor o devolve nos status e permite reconciliar um envio duvidoso. */
  opaque: string;
}

export interface SendResult {
  providerMessageId: string;
}

export interface ChannelCapabilities {
  /** Janela de atendimento em horas (fora dela só template), ou `null` se o canal não tem. */
  serviceWindowHours: number | null;
  templates: boolean;
  reactions: boolean;
  quotedReplies: boolean;
  interactive: { buttons: boolean; lists: boolean; ctaUrl: boolean };
  readReceipts: boolean;
  typingIndicator: boolean;
  media: ('image' | 'audio' | 'video' | 'document' | 'sticker')[];
}

export interface ClassifiedError {
  /** Vale tentar de novo (throttling, falha transitória)? */
  retryable: boolean;
  /** Código estável do WayChat (`window_closed`, `rate_limited`...), independente do provedor. */
  code: string;
  /** Mensagem em português para o atendente. */
  userMessage: string;
}

export interface ChannelAdapter {
  type: ChannelType;
  /** `true` só se a assinatura/token conferem. Nunca lança por entrada malformada: apenas devolve `false`. */
  verifyWebhook(req: RawRequest, config: InboxConfig): Promise<boolean>;
  parseWebhook(payload: unknown): NormalizedEvent[];
  send(msg: OutboundMessage, config: InboxConfig): Promise<SendResult>;
  downloadMedia?(ref: MediaRef, config: InboxConfig): Promise<Readable>;
  capabilities(): ChannelCapabilities;
  classifyError(err: unknown): ClassifiedError;
}
