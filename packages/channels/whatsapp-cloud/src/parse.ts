import type {
  DeliveryStatus,
  InboundContent,
  NormalizedEvent,
  ProviderError,
  SharedContact,
} from '@waychat/channels';
import { z } from 'zod';

/** Um número de telefone/wa_id chega como string; o timestamp, em segundos, também como string. */
const seconds = (v: string) => new Date(Number(v) * 1000);

const mediaObj = z.object({
  id: z.string(),
  mime_type: z.string(),
  sha256: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
  animated: z.boolean().optional(),
});

const errorObj = z.object({
  code: z.number(),
  title: z.string().optional(),
  message: z.string().optional(),
  details: z.string().optional(),
  error_data: z.object({ details: z.string().optional() }).optional(),
});

const rawMessage = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string(),
    type: z.string(),
    context: z.object({ id: z.string().optional(), from: z.string().optional() }).optional(),
    text: z.object({ body: z.string() }).optional(),
    image: mediaObj.optional(),
    video: mediaObj.optional(),
    audio: mediaObj.optional(),
    document: mediaObj.optional(),
    sticker: mediaObj.optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
      })
      .optional(),
    contacts: z
      .array(
        z.object({
          name: z.object({ formatted_name: z.string().optional() }).optional(),
          phones: z
            .array(
              z.object({
                phone: z.string().optional(),
                wa_id: z.string().optional(),
                type: z.string().optional(),
              }),
            )
            .optional(),
          emails: z.array(z.object({ email: z.string().optional() })).optional(),
        }),
      )
      .optional(),
    reaction: z.object({ message_id: z.string(), emoji: z.string().optional() }).optional(),
    interactive: z
      .object({
        type: z.string(),
        button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
        list_reply: z
          .object({ id: z.string(), title: z.string(), description: z.string().optional() })
          .optional(),
      })
      .optional(),
    button: z.object({ text: z.string(), payload: z.string().optional() }).optional(),
    errors: z.array(errorObj).optional(),
  })
  .loose();
type RawMessage = z.infer<typeof rawMessage>;

const rawStatus = z.object({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  recipient_id: z.string(),
  biz_opaque_callback_data: z.string().optional(),
  errors: z.array(errorObj).optional(),
});

const metadata = z.object({
  phone_number_id: z.string(),
  display_phone_number: z.string().optional(),
});

const envelope = z.object({
  entry: z.array(
    z.object({
      id: z.string().optional(),
      changes: z.array(z.object({ field: z.string(), value: z.record(z.string(), z.unknown()) })),
    }),
  ),
});

function toError(e: z.infer<typeof errorObj>): ProviderError {
  const details = e.error_data?.details ?? e.details;
  return {
    code: e.code,
    title: e.title ?? '',
    message: e.message ?? e.title ?? '',
    ...(details ? { details } : {}),
  };
}

const unsupported = (m: RawMessage, detail?: string): InboundContent => ({
  type: 'unsupported',
  providerType: m.type,
  ...(detail ? { detail } : {}),
});

function contentOf(m: RawMessage): InboundContent {
  const media = (o: z.infer<typeof mediaObj> | undefined) =>
    o
      ? {
          id: o.id,
          mimeType: o.mime_type,
          ...(o.sha256 ? { sha256: o.sha256 } : {}),
          ...(o.filename ? { fileName: o.filename } : {}),
        }
      : null;

  switch (m.type) {
    case 'text':
      return m.text ? { type: 'text', body: m.text.body } : unsupported(m, 'texto ausente');
    case 'image':
    case 'video':
    case 'document':
    case 'sticker': {
      const o = m[m.type];
      const ref = media(o);
      if (!o || !ref) return unsupported(m, 'mídia ausente');
      return {
        type: m.type,
        media: ref,
        ...(o.caption ? { caption: o.caption } : {}),
        ...(m.type === 'sticker' && o.animated !== undefined ? { animated: o.animated } : {}),
      };
    }
    case 'audio': {
      const ref = media(m.audio);
      return ref
        ? { type: 'audio', media: ref, voice: m.audio?.voice === true }
        : unsupported(m, 'mídia ausente');
    }
    case 'location':
      return m.location
        ? {
            type: 'location',
            latitude: m.location.latitude,
            longitude: m.location.longitude,
            ...(m.location.name ? { name: m.location.name } : {}),
            ...(m.location.address ? { address: m.location.address } : {}),
          }
        : unsupported(m, 'localização ausente');
    case 'contacts': {
      const contacts: SharedContact[] = (m.contacts ?? []).map((c) => ({
        name: c.name?.formatted_name ?? '',
        phones: (c.phones ?? []).flatMap((p) =>
          p.phone
            ? [
                {
                  phone: p.phone,
                  ...(p.wa_id ? { waId: p.wa_id } : {}),
                  ...(p.type ? { kind: p.type } : {}),
                },
              ]
            : [],
        ),
        emails: (c.emails ?? []).flatMap((e) => (e.email ? [e.email] : [])),
      }));
      return { type: 'contacts', contacts };
    }
    case 'reaction':
      // reação sem `emoji` = o cliente removeu a reação
      return m.reaction
        ? {
            type: 'reaction',
            targetProviderId: m.reaction.message_id,
            emoji: m.reaction.emoji ?? null,
          }
        : unsupported(m, 'reação ausente');
    case 'interactive': {
      const i = m.interactive;
      if (i?.type === 'button_reply' && i.button_reply)
        return { type: 'button_reply', replyId: i.button_reply.id, title: i.button_reply.title };
      if (i?.type === 'list_reply' && i.list_reply)
        return {
          type: 'list_reply',
          replyId: i.list_reply.id,
          title: i.list_reply.title,
          ...(i.list_reply.description ? { description: i.list_reply.description } : {}),
        };
      return unsupported(m, `interativa ${i?.type ?? 'desconhecida'}`);
    }
    case 'button':
      return m.button
        ? { type: 'button', text: m.button.text, payload: m.button.payload ?? m.button.text }
        : unsupported(m, 'botão ausente');
    default: {
      const first = m.errors?.[0];
      return unsupported(m, first ? (first.details ?? first.title) : undefined);
    }
  }
}

const STATUS: Record<string, DeliveryStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

const TEMPLATE_STATUS: Record<string, 'approved' | 'rejected' | 'pending' | 'paused' | 'disabled'> =
  {
    APPROVED: 'approved',
    REJECTED: 'rejected',
    PENDING: 'pending',
    PAUSED: 'paused',
    DISABLED: 'disabled',
  };

/**
 * Converte o corpo de um webhook da Meta em eventos normalizados. Regras:
 *  - um POST traz várias mudanças e várias mensagens: devolve todas, na ordem;
 *  - item malformado é descartado (ou vira `unsupported` quando dá para identificar a mensagem): um item ruim nunca
 *    impede os demais nem derruba o handler;
 *  - corpo que nem é um envelope da Meta lança (o handler responde 400 e registra).
 */
export function parseWebhook(payload: unknown): NormalizedEvent[] {
  const env = envelope.parse(payload);
  const out: NormalizedEvent[] = [];

  for (const entry of env.entry) {
    for (const change of entry.changes) {
      const v = change.value;
      if (change.field === 'messages') {
        const meta = metadata.safeParse(v['metadata']);
        if (!meta.success) continue;
        const accountRef = meta.data.phone_number_id;
        const names = new Map<string, string>();
        for (const c of z
          .array(
            z.object({
              wa_id: z.string(),
              profile: z.object({ name: z.string().optional() }).optional(),
            }),
          )
          .catch([])
          .parse(v['contacts'])) {
          if (c.profile?.name) names.set(c.wa_id, c.profile.name);
        }
        for (const raw of z.array(z.unknown()).catch([]).parse(v['messages'])) {
          const m = rawMessage.safeParse(raw);
          if (!m.success) continue;
          const name = names.get(m.data.from);
          out.push({
            kind: 'message',
            providerId: m.data.id,
            accountRef,
            from: { id: m.data.from, ...(name ? { name } : {}) },
            at: seconds(m.data.timestamp),
            ...(m.data.context?.id ? { replyToProviderId: m.data.context.id } : {}),
            content: contentOf(m.data),
          });
        }
        for (const raw of z.array(z.unknown()).catch([]).parse(v['statuses'])) {
          const s = rawStatus.safeParse(raw);
          const status = s.success ? STATUS[s.data.status] : undefined;
          if (!s.success || !status) continue; // "deleted", "warning"... não são estados de entrega
          const err = s.data.errors?.[0];
          out.push({
            kind: 'status',
            providerId: s.data.id,
            accountRef,
            status,
            recipientId: s.data.recipient_id,
            at: seconds(s.data.timestamp),
            ...(s.data.biz_opaque_callback_data ? { opaque: s.data.biz_opaque_callback_data } : {}),
            ...(err ? { error: toError(err) } : {}),
          });
        }
      } else if (change.field === 'message_template_status_update') {
        const t = z
          .object({
            event: z.string(),
            message_template_id: z.union([z.number(), z.string()]),
            message_template_name: z.string(),
            message_template_language: z.string(),
            reason: z.string().optional(),
          })
          .safeParse(v);
        if (!t.success) continue;
        out.push({
          kind: 'template_status',
          wabaId: entry.id ?? '',
          providerTemplateId: String(t.data.message_template_id),
          name: t.data.message_template_name,
          language: t.data.message_template_language,
          status: TEMPLATE_STATUS[t.data.event.toUpperCase()] ?? 'other',
          ...(t.data.reason && t.data.reason !== 'NONE' ? { reason: t.data.reason } : {}),
        });
      } else if (change.field === 'phone_number_quality_update') {
        const q = z
          .object({
            display_phone_number: z.string(),
            event: z.string(),
            current_limit: z.string().optional(),
          })
          .safeParse(v);
        if (!q.success) continue;
        out.push({
          kind: 'quality',
          wabaId: entry.id ?? '',
          displayPhone: q.data.display_phone_number,
          event: q.data.event,
          ...(q.data.current_limit ? { tier: q.data.current_limit } : {}),
        });
      }
    }
  }
  return out;
}
