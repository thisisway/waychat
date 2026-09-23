import { hash, verify } from '@node-rs/argon2';

// Argon2id (padrão do @node-rs/argon2) com os parâmetros mínimos recomendados pela OWASP: 19 MiB, 2 passes, 1 thread.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

let dummy: Promise<string> | undefined;

/**
 * Verifica a senha. Se o usuário não existe, verifica contra um hash descartável para que o tempo de resposta
 * não revele se o e-mail está cadastrado.
 */
export async function verifyPassword(
  password: string,
  storedHash: string | null,
): Promise<boolean> {
  dummy ??= hashPassword('descartavel-para-igualar-tempo');
  const target = storedHash ?? (await dummy);
  try {
    const ok = await verify(target, password);
    return ok && storedHash !== null;
  } catch {
    return false;
  }
}
