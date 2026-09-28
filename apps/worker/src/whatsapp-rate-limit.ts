import type { Redis } from 'ioredis';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Limitador de taxa por número (D9): janela fixa de 1 segundo em Valkey. Simples o bastante para o objetivo —
 * não é um token bucket de verdade, mas se comporta como um na prática (a janela vira a cada segundo).
 * Se a janela está cheia, espera um pouco e tenta de novo; sem exceder `maxWaitMs`, para não travar o worker
 * para sempre (o próximo job da fila tenta de novo).
 */
export async function acquireSendSlot(
  redis: Redis,
  inboxId: string,
  limitPerSecond: number,
  maxWaitMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const key = `wc:wa:rate:${inboxId}:${String(Math.floor(Date.now() / 1000))}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.pexpire(key, 1100);
    if (count <= limitPerSecond) return;
    if (Date.now() >= deadline) return;
    await sleep(Math.min(200, deadline - Date.now()));
  }
}
