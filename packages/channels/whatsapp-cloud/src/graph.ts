/** Configuração para falar com a Graph API da Meta (por inbox: cada uma tem o seu token). */
export interface GraphConfig {
  accessToken: string;
  /** `v23.0`... vem de `WHATSAPP_GRAPH_VERSION`. */
  version: string;
  /** `https://graph.facebook.com` (ou o servidor falso dos testes). */
  baseUrl: string;
  /** Injetável para teste; padrão é o `fetch` global. */
  fetch?: typeof fetch;
  /** Tempo máximo por chamada. */
  timeoutMs?: number;
}

/** Erro devolvido pela Graph API (ou falha de rede, com `status = 0`). */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

interface GraphErrorBody {
  error?: {
    code?: number;
    message?: string;
    error_data?: { details?: string };
    error_subcode?: number;
  };
}

export async function graphRequest(
  cfg: GraphConfig,
  path: string,
  init: { method?: string; body?: unknown; absolute?: boolean } = {},
): Promise<Response> {
  const doFetch = cfg.fetch ?? fetch;
  const url = init.absolute ? path : `${cfg.baseUrl}/${cfg.version}/${path.replace(/^\//, '')}`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${cfg.accessToken}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new GraphError(0, null, e instanceof Error ? e.message : 'falha de rede');
  }
  if (!res.ok) {
    let body: GraphErrorBody = {};
    try {
      body = (await res.json()) as GraphErrorBody;
    } catch {
      // corpo não é JSON (proxy, 502...): o status já diz o que houve
    }
    const err = body.error;
    throw new GraphError(
      res.status,
      err?.code ?? null,
      err?.message ?? `HTTP ${String(res.status)}`,
      err?.error_data?.details,
    );
  }
  return res;
}

export interface FetchedMedia {
  data: Buffer;
  mimeType: string;
}

/**
 * Baixa uma mídia recebida. Dois passos da Meta: `GET /{media-id}` devolve uma URL de vida curta e, com o mesmo
 * token, `GET <url>` entrega os bytes. `maxBytes` vale nos dois: recusa pelo tamanho anunciado e interrompe a leitura
 * se o corpo passar do limite (o anunciado pode mentir).
 */
export async function fetchMedia(
  cfg: GraphConfig,
  mediaId: string,
  maxBytes: number,
): Promise<FetchedMedia> {
  if (!/^\d{1,30}$/.test(mediaId)) throw new GraphError(400, null, 'id de mídia inválido');
  const meta = (await (await graphRequest(cfg, mediaId)).json()) as {
    url?: string;
    mime_type?: string;
    file_size?: number;
  };
  if (!meta.url || !meta.mime_type) throw new GraphError(502, null, 'resposta de mídia incompleta');
  if (typeof meta.file_size === 'number' && meta.file_size > maxBytes)
    throw new GraphError(413, null, 'mídia maior que o limite');
  const res = await graphRequest(cfg, meta.url, { absolute: true });
  if (!res.body) throw new GraphError(502, null, 'mídia sem corpo');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new GraphError(413, null, 'mídia maior que o limite');
    chunks.push(Buffer.from(chunk));
  }
  return { data: Buffer.concat(chunks), mimeType: meta.mime_type };
}
