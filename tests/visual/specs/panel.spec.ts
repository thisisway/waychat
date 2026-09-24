import { expect, test, type Page } from '@playwright/test';

// Tela de Conversas do painel (apps/web) com a API e o Socket.IO simulados. Tudo fixo: UUIDs, datas e o relógio.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-03-12T18:00:00.000Z'; // 15:00 em America/Sao_Paulo
const at = (day: number, hhmm: string) => `2026-03-${String(day).padStart(2, '0')}T${hhmm}:00.000Z`;

const ME = uuid(1);
const ME_DATA = {
  user: { id: ME, name: 'Ana Souza', email: 'ana@exemplo.com', locale: 'pt-BR' },
  account: { id: uuid(2), name: 'Loja Exemplo', slug: 'loja-exemplo', require2fa: false },
  role: { id: uuid(3), name: 'Administrador' },
  permissions: [],
};

const contact = (n: number, name: string, phone: string | null, email: string | null) => ({
  id: uuid(200 + n),
  name,
  phone,
  email,
});
const conv = (
  n: number,
  c: ReturnType<typeof contact>,
  lastMessage: string | null,
  lastActivityAt: string,
  unreadCount = 0,
  assigneeId: string | null = null,
) => ({
  id: uuid(300 + n),
  displayId: 1000 + n,
  inboxId: uuid(4),
  status: 'open' as const,
  priority: 'none',
  assigneeId,
  contact: c,
  lastMessage,
  lastActivityAt,
  unreadCount,
});

const ITEMS = [
  conv(
    1,
    contact(1, 'Marina Oliveira', '+55 11 91234-5678', null),
    'Meu pedido 4821 ainda não chegou.',
    at(12, '17:40'),
    3,
  ),
  conv(
    2,
    contact(2, 'Carlos Eduardo Albuquerque de Nascimento Filho', null, 'carlos@exemplo.com'),
    'Pode me mandar a nota fiscal?',
    at(12, '16:05'),
    1,
  ),
  conv(
    3,
    contact(3, 'Beatriz Lima', '+55 21 99876-5432', null),
    'Obrigada pela ajuda!',
    at(12, '14:30'),
    0,
    ME,
  ),
  conv(4, contact(4, 'Rafael Costa', null, null), 'Segue o comprovante em anexo.', at(11, '19:12')),
  conv(5, contact(5, 'Juliana Ferreira', null, 'ju@exemplo.com'), null, at(10, '13:00'), 0, ME),
  conv(
    6,
    contact(6, 'Pedro Martins', '+55 31 98888-1111', null),
    'Ok, aguardo retorno.',
    at(8, '12:20'),
  ),
];
const SELECTED = ITEMS[2]; // Beatriz: atribuída a mim, sem não lidas (evita chamar /read)

const DETAIL = {
  ...SELECTED,
  snoozedUntil: null,
  resolvedAt: null,
  createdAt: at(11, '13:15'),
  inbox: { id: uuid(4), name: 'Widget do site', channelType: 'widget' },
  labels: [
    { id: uuid(500), name: 'Suporte', color: '#1560ff' },
    { id: uuid(501), name: 'VIP', color: '#ffdb31' },
  ],
};

const msg = (
  n: number,
  direction: 'in' | 'out',
  content: string | null,
  createdAt: string,
  extra: Partial<{
    senderType: string;
    senderId: string | null;
    private: boolean;
    status: string;
    attachments: unknown[];
  }> = {},
) => ({
  id: uuid(700 + n),
  conversationId: SELECTED?.id,
  direction,
  senderType: direction === 'in' ? 'contact' : 'user',
  senderId: direction === 'out' ? ME : null,
  content,
  private: false,
  replyToId: null,
  status: 'read',
  clientMessageId: null,
  attachments: [],
  createdAt,
  ...extra,
});
const att = (n: number, fileName: string, size: number) => ({
  id: uuid(800 + n),
  fileName,
  contentType: 'application/pdf',
  size,
  status: 'clean',
});

// A API devolve da mais nova para a mais antiga; a tela inverte.
const MESSAGES = [
  msg(6, 'out', 'Enviei o arquivo corrigido, qualquer coisa é só chamar.', at(12, '14:30'), {
    senderId: uuid(9),
    status: 'delivered',
  }),
  msg(5, 'in', 'Obrigada pela ajuda!', at(12, '14:20')),
  msg(4, 'out', 'Segue a segunda via do boleto.', at(11, '13:40'), {
    attachments: [att(1, 'boleto-marco.pdf', 245_760)],
  }),
  msg(3, 'out', 'Cliente com histórico de atraso, oferecer parcelamento.', at(11, '13:35'), {
    private: true,
    status: 'sent',
  }),
  msg(2, 'out', 'Olá, Beatriz! Vou verificar agora mesmo.', at(11, '13:20'), { status: 'read' }),
  msg(1, 'in', 'Oi! Preciso da segunda via do boleto.', at(11, '13:15')),
];

const CANNED = [{ id: uuid(600), shortcut: 'oi', content: 'Olá! Como posso ajudar?' }];
const LABELS = [...DETAIL.labels, { id: uuid(502), name: 'Financeiro', color: '#0a9426' }];

/** Simula API HTTP e Socket.IO principal; o servidor estático só entrega o painel. */
async function setup(page: Page, theme: 'light' | 'dark') {
  await page.clock.setFixedTime(new Date(NOW)); // "hoje" = 12/03/2026 nas horas dos itens
  await page.addInitScript((t) => {
    localStorage.setItem('waychat-theme', t);
  }, theme);

  await page.route('**/upload', (r) => r.fulfill({ status: 204 }));
  await page.route(
    (url) =>
      ['/auth', '/conversations', '/canned-responses', '/labels', '/attachments', '/sync'].some(
        (p) => url.pathname.startsWith(p),
      ),
    async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      const method = req.method();
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      // arquivos "video*" ficam para sempre em verificação
      const scanning = path.includes('video');

      if (path === '/auth/me') return json(ME_DATA);
      if (path === '/conversations/counts')
        return json({ all: 6, unassigned: 4, mine: 2, unread: 2 });
      if (path === '/conversations') return json({ items: ITEMS, nextCursor: null });
      if (path === `/conversations/${SELECTED?.id ?? ''}`) return json(DETAIL);
      if (path.endsWith('/messages')) return json({ items: MESSAGES, nextCursor: null });
      if (path === '/canned-responses') return json({ items: CANNED });
      if (path === '/labels') return json({ items: LABELS });
      if (path === '/sync') return json({ events: [], cursor: 1, has_more: false });
      if (method === 'POST' && path.endsWith('/attachments')) {
        const { file_name } = req.postDataJSON() as { file_name: string };
        return json(
          {
            attachment: {
              id: `arquivo-${file_name}`,
              fileName: file_name,
              size: 1,
              status: 'awaiting_upload',
            },
            upload: { url: new URL('/upload', req.url()).href, fields: { key: 'fixo' } },
          },
          201,
        );
      }
      if (path.startsWith('/attachments/')) {
        return json({ attachment: { status: scanning ? 'scanning' : 'clean' } });
      }
      return route.fulfill({ status: 404 });
    },
  );

  await page.routeWebSocket(/\/socket\.io\//, (ws) => {
    ws.send('0{"sid":"x","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
    ws.onMessage((m) => {
      const s = String(m);
      if (s === '2') ws.send('3');
      else if (s.startsWith('40')) {
        ws.send('40{"sid":"y"}');
        ws.send('42["ready",{"cursor":1,"online":[]}]');
      }
    });
  });
}

/** Espera a tela assentar (dados, fonte Plus Jakarta Sans) antes de fotografar. */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText('Reconectando…')).toHaveCount(0);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`painel (${theme})`, () => {
    test.use({ viewport: { width: 1500, height: 900 }, colorScheme: theme });
    const shot = (name: string) => ['panel', `${name}-${theme}.png`];

    test('lista sem conversa selecionada', async ({ page }) => {
      await setup(page, theme);
      await page.goto('/');
      await expect(page.getByText('Marina Oliveira')).toBeVisible();
      await expect(page.getByText('Selecione uma conversa')).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(shot('lista'));
    });

    test('conversa aberta com painel de informações', async ({ page }) => {
      await setup(page, theme);
      await page.goto(`/?c=${SELECTED?.id ?? ''}&f=all`);
      await expect(page.getByText('boleto-marco.pdf')).toBeVisible();
      await expect(page.getByText('Cliente com histórico de atraso')).toHaveCount(2); // bolha + nota lateral
      await expect(page.getByText('Suporte').first()).toBeVisible();
      await settle(page);
      await expect(page).toHaveScreenshot(shot('conversa'));
    });

    test('compositor com rascunho de anexos', async ({ page }) => {
      await setup(page, theme);
      await page.goto(`/?c=${SELECTED?.id ?? ''}&f=all`);
      await expect(page.getByText('boleto-marco.pdf')).toBeVisible();
      await page.getByLabel('Selecionar arquivos').setInputFiles([
        { name: 'contrato.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(1_048_576) },
        { name: 'video-demonstracao.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048) },
        { name: 'planilha.exe', mimeType: 'application/octet-stream', buffer: Buffer.alloc(4096) },
      ]);
      const drafts = page.getByRole('list', { name: 'Arquivos a enviar' });
      await expect(drafts).toContainText('1,0 MB'); // pronto
      await expect(drafts).toContainText('Verificando…');
      await expect(drafts).toContainText('Tipo não permitido');
      await settle(page);
      await expect(page).toHaveScreenshot(shot('rascunho'));
    });

    test.describe('mobile', () => {
      test.use({ viewport: { width: 390, height: 844 } });
      test('lista', async ({ page }) => {
        await setup(page, theme);
        await page.goto('/');
        await expect(page.getByText('Marina Oliveira')).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(shot('mobile-lista'));
      });
    });
  });
}
