/** Janela de atendimento do WhatsApp: fora dela, só um template aprovado pode ser mandado. */
export const WHATSAPP_WINDOW_HOURS = 24;

export interface ServiceWindow {
  open: boolean;
  /** `null` só quando o contato nunca escreveu (não há janela para calcular). */
  expiresAt: Date | null;
}

/**
 * Janela de 24h a partir da última mensagem do cliente (D7). `null` = o canal não tem esse conceito (hoje, todos
 * menos o WhatsApp): a UI e a validação de envio simplesmente ignoram a janela para eles.
 */
export function serviceWindowFor(
  channelType: string,
  lastCustomerMessageAt: Date | null,
  now: Date,
): ServiceWindow | null {
  if (channelType !== 'whatsapp') return null;
  if (!lastCustomerMessageAt) return { open: false, expiresAt: null };
  const expiresAt = new Date(lastCustomerMessageAt.getTime() + WHATSAPP_WINDOW_HOURS * 3_600_000);
  return { open: expiresAt.getTime() > now.getTime(), expiresAt };
}
