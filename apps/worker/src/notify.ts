import pg from 'pg';

export const OUTBOX_CHANNEL = 'waychat_outbox';

/**
 * Escuta o NOTIFY que o trigger do outbox dispara a cada COMMIT com eventos novos. Conexão própria (LISTEN prende a
 * conexão). Se cair, reconecta com espera crescente; enquanto isso o polling do relay continua entregando.
 */
export function listenOutbox(
  connectionString: string,
  onNotify: () => void,
  onError?: (err: unknown) => void,
): () => Promise<void> {
  let client: pg.Client | null = null;
  let stopped = false as boolean;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const c = new pg.Client({ connectionString });
    client = c;
    c.on('notification', () => {
      onNotify();
    });
    c.on('error', (err) => {
      onError?.(err);
      void c.end().catch(() => undefined);
    });
    c.on('end', () => {
      if (stopped) return;
      attempt += 1;
      retry = setTimeout(() => void connect(), Math.min(30_000, 500 * 2 ** attempt));
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${OUTBOX_CHANNEL}`);
      attempt = 0;
      onNotify(); // pode ter entrado evento enquanto estava desconectado
    } catch (err) {
      onError?.(err);
      void c.end().catch(() => undefined);
    }
  };
  void connect();

  return async () => {
    stopped = true;
    clearTimeout(retry);
    await client?.end().catch(() => undefined);
  };
}
