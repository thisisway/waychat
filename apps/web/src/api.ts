export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** O cookie `wc_csrf` é legível de propósito (double-submit): o valor volta no header X-CSRF-Token. */
function csrfToken(): string {
  const m = /(?:^|;\s*)wc_csrf=([^;]+)/.exec(document.cookie);
  return m?.[1] ? decodeURIComponent(m[1]) : '';
}

let refreshing: Promise<boolean> | null = null;

/**
 * Renova a sessão pelo cookie de refresh (HttpOnly). "Single-flight": várias requisições que tomam 401 ao mesmo
 * tempo compartilham UMA renovação. O servidor trata duas rotações simultâneas do mesmo token como reuso e derruba
 * a sessão inteira, então nunca pode haver duas em paralelo.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/auth/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-csrf-token': csrfToken() },
  })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

const NO_REFRESH = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/mfa'];

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const send = () =>
    fetch(path, {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-csrf-token': csrfToken() } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  let res = await send();
  if (
    res.status === 401 &&
    !NO_REFRESH.some((p) => path.startsWith(p)) &&
    (await refreshSession())
  ) {
    res = await send();
  }
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? 'Algo deu errado.');
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body);
export const patch = <T>(path: string, body?: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);
