interface PgLikeError {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

function findPgError(e: unknown): PgLikeError | null {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    if ('code' in cur && typeof (cur as PgLikeError).code === 'string') return cur as PgLikeError;
    cur = (cur as PgLikeError).cause;
  }
  return null;
}

/** Retorna o nome da constraint se `e` for violação de unicidade (23505) do Postgres; senão null. O Drizzle embrulha o erro em `cause`. */
export function uniqueViolation(e: unknown): string | null {
  const pg = findPgError(e);
  return pg?.code === '23505' ? (pg.constraint ?? '') : null;
}
