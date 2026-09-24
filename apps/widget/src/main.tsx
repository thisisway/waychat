import { render } from 'preact';
import { io } from 'socket.io-client';
import { Chat } from './chat.js';
import { pickLocale, strings } from './i18n.js';
import { css } from './styles.js';
import { Widget } from './widget.js';

/**
 * Snippet do cliente:
 *   <script src="https://chat.exemplo.com/waychat-widget.js" data-key="ibx_xxx" async></script>
 * Opcionais: data-locale, data-color e, para usuário logado, data-user-id + data-user-hmac
 * (o HMAC é gerado no servidor do cliente com o segredo de identidade; nunca no navegador).
 */
function boot(): void {
  const el = document.currentScript ?? document.querySelector('script[data-key]');
  if (!(el instanceof HTMLScriptElement)) return;
  const publicKey = el.dataset['key'];
  if (!publicKey) return;
  const api = el.dataset['api'] ?? new URL(el.src).origin;
  const userId = el.dataset['userId'];
  const hmac = el.dataset['userHmac'];

  const storage = ((): Storage | null => {
    try {
      return window.localStorage;
    } catch {
      return null; // bloqueado pelo navegador
    }
  })();

  const chat = new Chat(
    { api, publicKey, ...(userId && hmac ? { identity: { user_id: userId, hmac } } : {}) },
    {
      fetch: (i, init) => fetch(i, init),
      connect: (url, token) =>
        io(url, { transports: ['websocket'], auth: { token }, reconnectionDelayMax: 10_000 }),
      storage,
      uuid: () => crypto.randomUUID(),
    },
  );
  if (chat.returning) void chat.start();

  const locale = pickLocale(el.dataset['locale'] ?? navigator.language);
  const host = document.createElement('div');
  host.id = 'waychat-widget';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  const mount = document.createElement('div');
  root.append(style, mount);
  document.body.append(host);
  const color = el.dataset['color'];
  render(
    <Widget chat={chat} t={strings(locale)} locale={locale} {...(color ? { color } : {})} />,
    mount,
  );
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
