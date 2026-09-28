import { graphRequest, type GraphConfig } from './graph.js';

/** Espelha o formato de componente da Meta (cabeçalho/corpo/rodapé/botões de um template). */
export interface RemoteTemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text?: string;
  buttons?: { type: string; text: string; url?: string; phone_number?: string }[];
}

export interface RemoteTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: RemoteTemplateComponent[];
  rejected_reason?: string;
}

interface ListResponse {
  data: RemoteTemplate[];
  paging?: { next?: string };
}

export type TemplateStatus = 'approved' | 'rejected' | 'pending' | 'paused' | 'disabled' | 'other';

const STATUS_MAP: Record<string, TemplateStatus> = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PENDING: 'pending',
  PAUSED: 'paused',
  DISABLED: 'disabled',
};

/** A Meta devolve o status em maiúsculas, tanto na listagem quanto no webhook (mesmo mapeamento do `parse.ts`). */
export const normalizeTemplateStatus = (raw: string): TemplateStatus =>
  STATUS_MAP[raw.toUpperCase()] ?? 'other';

/**
 * Lista todos os templates da conta (segue a paginação da Meta até o fim). `wabaId` é o id da conta comercial
 * (WABA), não o Phone Number ID.
 */
export async function listTemplates(cfg: GraphConfig, wabaId: string): Promise<RemoteTemplate[]> {
  const out: RemoteTemplate[] = [];
  let path = `${wabaId}/message_templates?fields=id,name,language,category,status,components,rejected_reason&limit=100`;
  let absolute = false;
  for (;;) {
    const res = await graphRequest(cfg, path, { absolute });
    const body = (await res.json()) as ListResponse;
    out.push(...body.data);
    if (!body.paging?.next) return out;
    path = body.paging.next; // já é a URL completa
    absolute = true;
  }
}

export interface CreateTemplateInput {
  name: string;
  language: string;
  category: string;
  components: RemoteTemplateComponent[];
}

export interface CreatedTemplate {
  id: string;
  status: string;
  category: string;
}

export async function createTemplate(
  cfg: GraphConfig,
  wabaId: string,
  input: CreateTemplateInput,
): Promise<CreatedTemplate> {
  const res = await graphRequest(cfg, `${wabaId}/message_templates`, {
    method: 'POST',
    body: {
      name: input.name,
      language: input.language,
      category: input.category,
      components: input.components,
    },
  });
  return (await res.json()) as CreatedTemplate;
}
