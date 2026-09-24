import { expect, test, type Page } from '@playwright/test';

const KEY = 'ibx_visual';

/** UUIDs e horários fixos: nada aleatório nem dependente do relógio da máquina. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
interface Att {
  id: string;
  file_name: string;
  content_type: string;
  size: number;
}
const att = (n: number, file_name: string, size: number): Att => ({
  id: uuid(900 + n),
  file_name,
  content_type: 'application/pdf',
  size,
});
const msg = (n: number, from: 'visitor' | 'agent', content: string, at: string, a: Att[] = []) => ({
  id: uuid(n),
  from,
  content,
  created_at: `2026-03-12T${at}:00.000Z`, // 17:02 UTC = 14:02 em America/Sao_Paulo
  client_message_id: from === 'visitor' ? uuid(100 + n) : null,
  attachments: a,
});

const CONVERSA = [
  msg(1, 'visitor', 'Oi! Meu pedido 4821 ainda não chegou.', '17:02'),
  msg(2, 'agent', 'Olá, Marina! Vou verificar agora mesmo.', '17:03'),
  msg(3, 'visitor', 'Obrigada. Fico no aguardo.', '17:04'),
];
const COM_ANEXOS = [
  msg(1, 'visitor', 'Oi! Meu pedido 4821 ainda não chegou.', '17:02'),
  msg(2, 'agent', 'Olá, Marina! Pode enviar o comprovante?', '17:03'),
  msg(3, 'visitor', 'Segue o comprovante e a foto da caixa.', '17:04', [
    att(1, 'comprovante-pagamento.pdf', 245_760),
    att(2, 'foto-da-caixa-danificada-com-nome-bem-longo.png', 2_411_724),
  ]),
  msg(4, 'agent', 'Recebi, obrigado!', '17:05'),
];

interface Options {
  /** Histórico devolvido pela API. Vazio + visitante novo = pré-chat. */
  messages?: ReturnType<typeof msg>[];
  /** Visitante que já conversou antes (o widget conecta ao carregar). */
  returning?: boolean;
  /** Simula o Socket.IO do namespace /widget; sem isso o widget fica "Reconectando…". */
  socket?: boolean;
}

/** Simula a API (HTTP) e o Socket.IO; o servidor estático só entrega o widget e a página. */
async function setup(page: Page, { messages = [], returning = false, socket = true }: Options) {
  if (returning) {
    await page.addInitScript((k) => {
      localStorage.setItem(`waychat:${k}:visitor`, 'visitante-fixo');
      localStorage.setItem(
        `waychat:${k}:profile`,
        JSON.stringify({ name: 'Marina', email: 'marina@exemplo.com' }),
      );
    }, KEY);
  }

  await page.route('**/upload', (r) => r.fulfill({ status: 204 }));
  await page.route('**/widget/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.slice('/widget/v1'.length);
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    // arquivos "video*" ficam para sempre em verificação (o antivírus ainda não liberou)
    const scanning = path.includes('video');

    if (path === '/session') {
      return json({
        token: 'token-fixo',
        expires_at: '2026-03-12T18:00:00.000Z',
        visitor_id: 'visitante-fixo',
        identified: false,
        inbox: { name: 'Loja de teste', welcome_message: null, primary_color: null },
      });
    }
    if (path === '/messages') return json({ items: messages });
    if (path === '/attachments') {
      const { file_name } = req.postDataJSON() as { file_name: string };
      return json(
        {
          attachment: { id: `arquivo-${file_name}`, status: 'pending' },
          upload: { url: new URL('/upload', req.url()).href, fields: { key: 'fixo' } },
        },
        201,
      );
    }
    if (path.endsWith('/complete')) {
      return json({ attachment: { status: scanning ? 'pending' : 'clean' } });
    }
    if (path.endsWith('/url')) {
      return scanning ? json({}, 404) : json({ url: 'https://arquivos.exemplo.com/fixo' });
    }
    return route.fulfill({ status: 404 });
  });

  if (socket) {
    await page.routeWebSocket(/\/socket\.io\//, (ws) => {
      ws.send('0{"sid":"x","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
      ws.onMessage((m) => {
        const s = String(m);
        if (s.startsWith('40/widget')) {
          ws.send('40/widget,{"sid":"y"}');
          ws.send('42/widget,["ready"]');
        } else if (s === '2') ws.send('3');
      });
    });
  }
  await page.goto('/widget.html');
}

/** Abre o painel e espera fontes e conexão assentarem; devolve o painel (raiz do que se fotografa). */
async function openPanel(page: Page, { connected = true } = {}) {
  await page.getByRole('button', { name: 'Abrir chat' }).click();
  const panel = page.locator('#waychat-widget .panel');
  await expect(panel).toBeVisible();
  if (connected) await expect(panel.locator('.status')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  return panel;
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`widget (${scheme})`, () => {
    test.use({ colorScheme: scheme });
    const shot = (name: string) => ['widget', `${name}-${scheme}.png`];

    test('launcher fechado', async ({ page }) => {
      await setup(page, {});
      const launcher = page.locator('#waychat-widget .launcher');
      await expect(launcher).toBeVisible();
      await expect(launcher).toHaveScreenshot(shot('launcher'));
    });

    test('pré-chat', async ({ page }) => {
      await setup(page, {});
      const panel = await openPanel(page);
      await expect(panel.getByText('Antes de começar')).toBeVisible();
      await expect(panel).toHaveScreenshot(shot('pre-chat'));
    });

    test('conversa', async ({ page }) => {
      await setup(page, { messages: CONVERSA, returning: true });
      const panel = await openPanel(page);
      await expect(panel.locator('.msg')).toHaveCount(3);
      await expect(panel).toHaveScreenshot(shot('conversa'));
    });

    test('conversa com anexo na bolha', async ({ page }) => {
      await setup(page, { messages: COM_ANEXOS, returning: true });
      const panel = await openPanel(page);
      await expect(panel.locator('.msg .chip')).toHaveCount(2);
      await expect(panel).toHaveScreenshot(shot('anexo-na-bolha'));
    });

    test('rascunho com chips (pronto, verificando, erro)', async ({ page }) => {
      await setup(page, { messages: CONVERSA, returning: true });
      const panel = await openPanel(page);
      await panel.locator('input[type=file]').setInputFiles([
        { name: 'contrato.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(1_048_576) },
        { name: 'video-demonstracao.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048) },
        { name: 'planilha.exe', mimeType: 'application/octet-stream', buffer: Buffer.alloc(4096) },
      ]);
      const drafts = panel.locator('.drafts');
      await expect(drafts.locator('.chip')).toHaveCount(3);
      await expect(drafts).toContainText('Verificando…');
      await expect(drafts).toContainText('Tipo de arquivo não permitido');
      await expect(drafts).not.toContainText('Enviando…');
      await expect(panel).toHaveScreenshot(shot('rascunho-chips'));
    });

    test('reconectando', async ({ page }) => {
      await setup(page, { messages: CONVERSA, returning: true, socket: false });
      const panel = await openPanel(page, { connected: false });
      await expect(panel.locator('.status')).toHaveText('Reconectando…');
      await expect(panel.locator('.msg')).toHaveCount(3);
      await expect(panel).toHaveScreenshot(shot('reconectando'));
    });

    test.describe('mobile', () => {
      test.use({ viewport: { width: 390, height: 844 } });
      test('conversa com anexo', async ({ page }) => {
        await setup(page, { messages: COM_ANEXOS, returning: true });
        const panel = await openPanel(page);
        await expect(panel.locator('.msg .chip')).toHaveCount(2);
        await expect(panel).toHaveScreenshot(shot('mobile'));
      });
    });
  });
}
